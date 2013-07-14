var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(infoHash, files, pieceHashes, pieceLength) {
    this.size = 0;
    files.forEach(function(file) {
	this.size += file.size;
    }.bind(this));
    this.pieceLength = pieceLength;

    var infoHashHex = bufferToHex(infoHash);
    this.backend = new StoreBackend(infoHashHex);

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

    this.sha1Worker = new SHA1Worker();
}
Store.prototype = {
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
	    if (piece.state !== 'valid' && peer.has(i))
		return true;
	}
	return false;
    },

    nextToDownload: function(peer) {
	var readahead = 0;
	var eligiblePieces = this.pieces.filter(function(piece) {
	    if (piece.valid)
		return false;
	    if (piece.onValidCbs.length > 0) {
		readahead = 3;
		return true;
	    } else if (readahead > 0) {
		readahead--;
		return true;
	    } else
		return false;
	});
	// console.log("eligiblePieces", eligiblePieces);
	if (eligiblePieces.length == 0)
	    eligiblePieces = this.pieces;

	for(var i = 0; i < eligiblePieces.length; i++) {
	    var piece = eligiblePieces[i];
	    var chunk =
		peer.has(piece.pieceNumber) &&
		piece.nextToDownload(peer);
	    if (chunk) {
		chunk.piece = piece.pieceNumber;
		return chunk;
	    }
	}

	return null;
    },

    getDonePercent: function() {
	var done = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (this.pieces[i].valid)
		done++;
	}
	return Math.floor(100 * done / this.pieces.length);
    },

    // TODO
    consumeFile: function(path, offset, cb) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    var found = false, length = 0;
	    for(var j = 0; j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		if (arrayEq(chunk.path, path) && chunk.fileOffset <= offset && chunk.fileOffset + chunk.length > offset) {
		    found = true;
		    length += chunk.fileOffset - offset + chunk.length;
		} else if (found && arrayEq(chunk.path, path) && chunk.fileOffset > offset) {
		    length += chunk.length;
		}
	    }
	    if (found) {
		piece.addOnValid(function() {
		    this.readFile(path, offset, length, function(data) {
			cb(data);
		    });
		}.bind(this));
		return;
	    }
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
	var i;
	for(i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.onValidCbs.length > 0 && piece.canContinueHashing())
		return piece;
	}
	for(i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.canContinueHashing())
		return piece;
	}
    },

    mayHash: function() {
	if (this.hashing)
	    return;

	/* Keep hashing the same piece for as long as possible */
	if (!this.hashingPiece || !this.hashingPiece.canContinueHashing())
	    this.hashingPiece = this.nextToHash();

	if (this.hashingPiece) {
console.log("hashingPiece", this.hashingPiece);
	    this.hashingPiece.continueHashing(function() {
		this.hashing = false;
		this.mayHash();
	    }.bind(this));
	    this.hashing = true;
	}
    }
};

var CHUNK_LENGTH = Math.pow(2, 15);

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
    state: 'missing',

    nextToDownload: function(peer) {
	var result, requestedChunks = [];
	for(var i = 0; i < this.chunks.length && (!result || result.length < CHUNK_LENGTH); i++) {
	    var chunk = this.chunks[i];
	    if (result || chunk.state === 'missing') {
		chunk.state = 'requested';
		chunk.peer = peer;
		if (!result)
		    result = {
			offset: chunk.offset,
			length: 0
		    };
		result.length += chunk.length;
		requestedChunks.push(chunk);
	    }
	}
	var onPieceMissing = this.store.onPieceMissing.bind(this, this.pieceNumber);
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
	data.buffers.forEach(function(buf) {
	    this.sha1pos += buf.byteLength;
	    /* TODO: could add asynchronous back-pressure with a cb() */
	    this.store.sha1Worker.update(this.pieceNumber, buf);
	    /* buf is neutered here, don't reuse data */
	}.bind(this));

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
		cb();
	    }.bind(this));
	} else
	    cb();
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
		cb();
	    });
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
    this.worker = new Worker("sha1-worker.js");
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

function arrayEq(a1, a2) {
    if (a1.length !== a2.length)
	return false;

    for(var i = 0; i < a1.length; i++)
	if (a1[i] !== a2[i])
	    return false;

    return true;
}

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
