var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(torrent, pieceHashes, pieceLength) {
    this.torrent = torrent;
    this.size = 0;
    var files = torrent.files;
    files.forEach(function(file) {
	this.size += file.size;
    }.bind(this));
    this.pieceLength = pieceLength;

    var infoHashHex = bufferToHex(torrent.infoHash);
    this.backend = new StoreBackend(infoHashHex, this.onExisting.bind(this));

    this.pieces = [];
    /* Build pieces... */
    var filesIdx = 0, fileOffset = 0;
    while(filesIdx < files.length) {
	var pieceOffset = 0;
	var chunks = [];
	/* ...from files */
	while(pieceOffset < pieceLength && filesIdx < files.length) {
	    var length = Math.min(pieceLength - pieceOffset, files[filesIdx].size - fileOffset);
	    chunks.push({ path: files[filesIdx].path,
			  fileOffset: fileOffset,
			  offset: pieceOffset,
			  length: length });
	    pieceOffset += length;
	    fileOffset += length;
	    if (fileOffset >= files[filesIdx].size) {
		filesIdx++;
		fileOffset = 0;
	    }
	}
	this.pieces.push(new StorePiece(this, this.pieces.length, chunks, pieceHashes[this.pieces.length]));
    }
    this.fileEntries = {};
    /* Lower bound for interestingPieces */
    this.interestingPiecesThreshold = Math.max(2, Math.ceil(2 * 1024 * 1024 / pieceLength));
    /* Upper bound for interestingPieces */
    this.piecesReadahead = 2 * this.interestingPiecesThreshold;
    this.interestingPieces = [];

    this.sha1Worker = new SHA1Worker();
}
Store.prototype = {
    /* Called back by StoreBackend() when initializing */
    onExisting: function(offset, length) {
	for(var i = Math.floor(offset / this.pieceLength);
	    i < this.pieces.length && i < (offset + length) / this.pieceLength;
	    i++) {

	    var pieceOffset = i * this.pieceLength;
	    var piece = this.pieces[i];
	    for(var j = 0; j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		if (pieceOffset + chunk.offset >= offset &&
		    pieceOffset + chunk.offset + chunk.length <= offset + length)
		    chunk.state = 'written';
	    }
	}
	this.mayHash();
    },

    remove: function() {
	if (this.sha1Worker) {
	    this.sha1Worker.terminate();
	    this.sha1Worker = null;
	}
	this.backend.remove();
	// HACKS to stop hashing:
	this.pieces.forEach(function(piece) {
	    piece.sha1pos = true;
	});
    },

    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (!piece.valid && peer.has(i))
		return true;
	}
	return false;
    },

    // TODO: could return up to a number chunks (optimization)
    nextToDownload: function(peer) {
	this.fillInterestingPieces(peer);

	for(var i = 0; i < this.interestingPieces.length; i++) {
	    var piece = this.interestingPieces[i];
	    var chunk =
		peer.has(piece.pieceNumber) &&
		piece.nextToDownload(peer);
	    if (chunk)
		return chunk;
	}

	return null;
    },

    fillInterestingPieces: function(hintPeer) {
	if (this.interestingPieces.length >= this.interestingPiecesThreshold)
	    /* Don't even start working unless neccessary */
	    return;

	/* Build rarity map */
	var rarity = {};
	var i, piece;
	for(i = 0; i < this.pieces.length; i++) {
	    piece = this.pieces[i];
	    if (piece.valid || (hintPeer && !hintPeer.has(i)))
		continue;

	    rarity[i] = 0;
	    this.torrent.peers.forEach(function(peer) {
		if (!peer.has(i))
		    rarity[i]++;
	    });
	}
	/* Select by highest rarity first, or randomly */
	var idxs = Object.keys(rarity).sort(function(idx1, idx2) {
	    var r1 = rarity[idx1], r2 = rarity[idx2];
	    if (r1 === r2)
		return Math.random() - 0.5;
	    else
		return r2 - r1;
	});
	for(i = 0; this.interestingPieces.length < this.piecesReadahead && i < idxs.length; i++) {
	    var idx = idxs[i];
	    piece = this.pieces[idx];
	    var alreadyPresent = this.interestingPieces.some(function(presentPiece) {
		return presentPiece.pieceNumber === idx;
	    });
	    if (!alreadyPresent) {
		this.interestingPieces.push(piece);
	    } else {
		console.log("already interesting:", idx);
	    }
	}
    },

    onPieceMissing: function(idx) {
	this.torrent.onPieceMissing(idx);
    },

    onPieceValid: function(idx) {
	this.interestingPieces = this.interestingPieces.filter(function(piece) {
	    return piece.pieceNumber !== idx;
	});
	this.torrent.onPieceValid(idx);
    },

    getDonePercent: function() {
	var done = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (this.pieces[i].valid)
		done++;
	}
	return Math.floor(100 * done / this.pieces.length);
    },

    getBytesLeft: function() {
	var result = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (!this.pieces[i].valid) {
		if (i < this.pieces.length - 1)
		    result += this.pieceLength;
		else
		    this.pieces[i].chunks.forEach(function(chunk) {
			result += chunk.length;
		    });
	    }
	}
	return result;
    },

    consumeFile: function(path, offset, cb) {
	var i, j, found = false;
	for(i = 0; !found && i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    for(j = 0; !found && j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		found = arrayEq(chunk.path, path) &&
		    chunk.fileOffset <= offset &&
		    chunk.fileOffset + chunk.length > offset;
		if (found) console.log("offset", offset, "found in piece", i, "chunk", j);
	    }
	}

	if (found) {
	    piece.addOnValid(function() {
		var chunkOffset = piece.pieceNumber * this.pieceLength + chunk.offset;
		console.log("read from", chunkOffset, "+", chunk.length);
		this.backend.readFrom(chunkOffset, function(data) {
		    if (data.byteLength > chunk.length)
			data = data.slice(0, chunk.length);
		    if (chunkOffset < offset)
			data = data.slice(offset - chunkOffset);
		    cb(data);
		});
	    }.bind(this));
	    
	    /* Interest for readahead */
	    var readahead = [];
	    for(i = piece.pieceNumber; i < Math.min(piece.pieceNumber + this.piecesReadahead, this.pieces.length); i++) {
		if (!this.pieces[i].valid)
		    readahead.push(i);
	    }
	    this.interestingPieces = readahead.map(function(i) {
		return this.pieces[i];
	    }.bind(this)).concat(this.interestingPieces.filter(function(piece) {
		return readahead.indexOf("" + piece.pieceNumber) === -1;
	    }));
	} else {
	    console.warn("consumeFile: not found", path, "+", offset);
	    cb();
	}
    },

    write: function(pieceNumber, offset, data, cb) {
	if (pieceNumber < this.pieces.length) {
	    var piece = this.pieces[pieceNumber];
	    if (piece.valid) {
		console.warn("Attempting to write to valid piece", this.pieceNumber);
		return;
	    }

	    piece.write(offset, data, function() {
		cb();
		this.mayHash();
	    }.bind(this));
	} else
	    cb();
    },

    nextToHash: function() {
	function lookForPiece(pieces) {
	    for(var i = 0; i < pieces.length; i++) {
		var piece = pieces[i];
		if (piece.canContinueHashing())
		    return piece;
	    }
	}
	return lookForPiece(this.interestingPieces) ||
	    lookForPiece(this.pieces);
    },

    mayHash: function() {
	if (this.hashing)
	    return;

	/* Keep hashing the same piece for as long as possible */
	if (!this.hashingPiece || !this.hashingPiece.canContinueHashing())
	    this.hashingPiece = this.nextToHash();

	if (this.hashingPiece) {
	    // console.log("hashingPiece", this.hashingPiece);
	    this.hashingPiece.continueHashing(function() {
		this.hashing = false;
		this.mayHash();
	    }.bind(this));
	    this.hashing = true;
	}
    }
};

var CHUNK_LENGTH = Math.pow(2, 14);  /* 16 KB */

function StorePiece(store, pieceNumber, chunks, expectedHash) {
    this.store = store;
    this.pieceNumber = pieceNumber;
    this.chunks = [];
    for(var i = 0; i < chunks.length; i++) {
	var chunk = chunks[i];
	while(chunk.length > 0) {
	    var l = Math.min(chunk.length, CHUNK_LENGTH);
	    this.chunks.push({
		path: chunk.path,
		fileOffset: chunk.fileOffset,
		offset: chunk.offset,
		length: l,
		state: 'missing'
	    });
	    chunk.fileOffset += l;
	    chunk.offset += l;
	    chunk.length -= l;
	}
    }

    this.expectedHash = expectedHash;
    this.sha1pos = 0;

    this.onValidCbs = [];
}
StorePiece.prototype = {
    nextToDownload: function(peer) {
	var result, requestedChunks = [];
	for(var i = 0; i < this.chunks.length && (!result || result.length < CHUNK_LENGTH); i++) {
	    var chunk = this.chunks[i];
	    if (result || chunk.state === 'missing') {
		chunk.state = 'requested';
		chunk.peer = peer;
		if (!result)
		    result = {
			piece: this.pieceNumber,
			offset: chunk.offset,
			length: 0
		    };
		result.length += chunk.length;
		requestedChunks.push(chunk);
	    }
	}
	var onPieceMissing = this.store.onPieceMissing.bind(this.store, this.pieceNumber);
	if (result)
	    result.cancel = function() {
		requestedChunks.forEach(function(chunk) {
		    chunk.peer = null;
		    if (chunk.state == 'requested')
			chunk.state = 'missing';
		    onPieceMissing();
		});
	    };
	return result;
    },

    read: function(offset, length, cb) {
	if (length < 1)
	    cb();
	else
	    this.store.backend.read(
		this.pieceNumber * this.store.pieceLength + offset,
		length,
		cb
	    );
    },

    write: function(offset, data, cb) {
	this.store.backend.write(
	    this.pieceNumber * this.store.pieceLength + offset,
	    data, function() {

	    for(var i = 0; i < this.chunks.length; i++) {
		var chunk = this.chunks[i];
		// TODO: may need to write to multiple chunks in multi-file torrents
		if (chunk.offset === offset &&
		    chunk.length === data.length)
		    chunk.state = 'written';
		else if (chunk.offset > offset)
		    break;
	    }

	    this.canHash(offset, data, cb);
	}.bind(this));
    },

    canHash: function(offset, data, cb) {
	if (offset > this.sha1pos)
	    return cb();
	else if (offset < this.sha1pos) {
	    data.take(this.sha1pos - offset);
	}
	// console.log("piece", this.store.pieces.indexOf(this), "canHash", offset, this.sha1pos);
	var pendingUpdates = 1;
	function onUpdated() {
	    pendingUpdates--;
	    if (pendingUpdates < 1 && cb)
		cb();
	}
	data.buffers.forEach(function(buf) {
	    this.sha1pos += buf.byteLength;
	    this.store.sha1Worker.update(this.pieceNumber, buf, onUpdated);
	    pendingUpdates++;
	    /* buf is neutered here, don't reuse data */
	}.bind(this));
	onUpdated();

	var chunk;
	for(var i = 0; i < this.chunks.length; i++) {
	    chunk = this.chunks[i];
	    if (chunk.offset + chunk.length > this.sha1pos) {
		/* Found a piece that follows */
		break;
	    } else if (chunk.offset + chunk.length <= this.sha1pos) {
		chunk.state = 'valid';
	    }
	}
	if (i >= this.chunks.length) {
	    /* No piece followed, validate hash */
	    this.store.sha1Worker.finalize(this.pieceNumber, function(hash) {
		this.onHashed(hash);
	    }.bind(this));
	}
    },

    canContinueHashing: function() {
	for(var i = 0;
	    i < this.chunks.length &&
	    (this.chunks[i].state == 'written' || this.chunks[i].state == 'valid') &&
	    this.chunks[i].offset <= this.sha1pos;
	    i++) {
	    // console.log("canContinueHashing", this.sha1pos, i, this.chunks, this.chunks[i].offset + this.chunks[i].length > this.sha1pos);
	    if (this.chunks[i].offset + this.chunks[i].length > this.sha1pos)
		return true;
	}
	return false;
    },

    continueHashing: function(cb) {
	for(var i = 0;
	    i < this.chunks.length &&
	    (this.chunks[i].state == 'written' || this.chunks[i].state == 'valid') &&
	    this.chunks[i].offset <= this.sha1pos;
	    i++) {

	    var chunk = this.chunks[i];
	    var start = this.sha1pos - chunk.offset;
	    if (start >= 0 && start < chunk.length) {
		var len = chunk.length - start;
		var offset = chunk.offset + start;
		this.read(offset, len, function(data) {
		    if (data.length > 0) {
			this.canHash(offset, data, cb);
		    } else {
			console.warn("cannotHash", this.pieceNumber, ":", this.chunks[i]);
			chunk.state = 'missing';
			this.store.onPieceMissing(this.pieceNumber);
			cb();
		    }
		}.bind(this));
		return;
	    } else if (start < 0) {
		console.log("cannot Hash", this.chunks, this.sha1pos);
		cb();
	    }
	}
    },

    onHashed: function(hash) {
	hash = new Uint8Array(hash);
	this.sha1 = null;

	var valid = true;
	for(var i = 0; i < 20; i++)
	    valid = valid && (hash[i] === this.expectedHash[i]);
	this.valid = valid;

	if (!valid) {
	    /* Hash corrupt: invalidate */
	    console.warn("Invalid piece", this.pieceNumber, ":", hash, "<>", this.expectedHash);

	    this.sha1pos = 0;
	    for(i = 0; i < this.chunks.length; i++) {
		if (this.chunks[i].state == 'valid')
		    this.chunks[i].state = 'missing';
	    }
	    this.store.onPieceMissing(this.pieceNumber);
	} else {
	    /* Hash checked: validate */
	    this.store.onPieceValid(this.pieceNumber);
	    var onValidCbs = this.onValidCbs;
	    this.onValidCbs = [];
	    onValidCbs.forEach(function(cb) {
		try {
		    cb();
		} catch (e) {
		    console.error("onValidCb", this.pieceNumber, e);
		}
	    }.bind(this));
	}
    },

    addOnValid: function(cb) {
	console.log("addOnValid", this.valid, this.pieceNumber);
	if (this.valid)
	    cb();
	else {
	    this.onValidCbs.push(cb);
	    this.store.onPieceMissing(this.pieceNumber);
	}
    }
};

function SHA1Worker() {
    this.worker = new Worker("src/sha1-worker.js");
    this.queue = [];
    this.worker.onmessage = function(ev) {
	var cb = this.queue.shift();
	if (cb)
	    cb(ev.data);
    }.bind(this);
}
SHA1Worker.prototype = {
    update: function(index, data, cb) {
	this.worker.postMessage({
	    update: {
		index: index,
		data: data
	    }
	}, [data]);
	this.queue.push(cb);
    },
    finalize: function(index, cb) {
	this.worker.postMessage({
	    finalize: {
		index: index
	    }
	});
	this.queue.push(function(data) {
	    cb(data.hash);
	});
    },
    terminate: function() {
	this.worker.terminate();
    }
};

function bufferToHex(b) {
    b = new Uint8Array(b);
    function pad(s, len) {
	while(s.length < len)
	    s = "0" + s;
	return s;
    }
    var r = "";
    for(var i = 0; i < b.length; i++)
	r += pad(b[i].toString(16), 2);
    return r;
}
