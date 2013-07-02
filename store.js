var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(files, pieceHashes, pieceLength) {
    this.size = 0;
    files.forEach(function(file) {
	this.size += file.size;
    }.bind(this));
    this.pieceLength = pieceLength;

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

    /* TODO: start hashing */
}
Store.prototype = {
    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.state !== 'valid' && peer.has(i))
		return true;
	}
	return false;
    },

    nextToDownload: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    var chunk = piece.state !== 'valid' &&
		peer.has(i) &&
		piece.nextToDownload(peer);
	    if (chunk) {
		chunk.piece = i;
		// console.log("nextToDownload", chunk);
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
		    this.readFile(path, offset, length, cb);
		}.bind(this));
		return;
	    }
	}
    },

    write: function(piece, offset, data, cb) {
	if (piece < this.pieces.length)
	    this.pieces[piece].write(offset, data, cb);
    },

    /* walks path parts asynchronously */
    getFileEntry: function(parts, cb) {
	requestFileSystem_(window.PERSISTENT, 0, function(fs) {
	    var dir = fs.root, partIdx = 0;
	    function walkParts() {
		var part = parts[partIdx];
		partIdx++;
		if (partIdx < parts.length) {
		    dir.getDirectory(part, { create: true }, function(entry) {
			dir = entry;
			walkParts();
		    }, function(err) {
			console.error("getDirectory", part, err);
		    });
		} else {
		    dir.getFile(part, { create: true }, function(entry) {
			cb(entry);
		    }, function(err) {
			console.error("getFile", part, err);
		    });
		}
	    }
	    walkParts();
	});
    },

    withFileEntry: function(parts, cb) {
	var id = parts.join("/");
	var fileEntries = this.fileEntries;

	if (!fileEntries.hasOwnProperty(id)) {
	    this.getFileEntry(parts, function(entry) {
		fileEntries[id] = entry;
		cb(entry);
	    });
	} else {
	    cb(fileEntries[id]);
	}
    },

    readFile: function(path, offset, length, cb) {
	var that = this;

	this.withFileEntry(path, function(entry) {
	    entry.file(function(file) {
		var reader = new FileReader();
		reader.onload = function() {
		    cb(reader.result);
		};
		reader.onerror = function(error) {
		    console.error("readFile", path, offset, length, error);
		    // HACK: retry later
		    setTimeout(/*that.readFile.bind(that, path, offset, length, cb)*/function() {
console.log("retrying", path, offset, length);
that.readFile(path,offset,length,cb);
}, 1000);
		};
		reader.readAsArrayBuffer(file.slice(offset, offset + length));
	    });
	});
    },

    writeFile: function(path, offset, data, cb) {
	this.withFileEntry(path, function(entry) {
	    entry.createWriter(function(writer) {
		writer.seek(offset);
		writer.onwriteend = function() {
		    cb();
		};
		writer.onerror = function(error) {
		    console.error("write", error);
		    cb();
		};
		writer.write(data.toBlob());
	    });
	});
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

    canHash: function(offset, data) {
	if (offset > this.sha1pos)
	    return;
	else if (offset < this.sha1pos) {
	    data.take(this.sha1pos - offset);
	}
	// console.log("piece", this.store.pieces.indexOf(this), "canHash", offset, this.sha1pos);
	if (!this.sha1)
	    this.sha1 = new Digest.SHA1();
	var sha1 = this.sha1;
	data.buffers.forEach(function(buf) {
	    sha1.update(buf);
	    this.sha1pos += buf.byteLength;
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
	    var hash = new Uint8Array(this.sha1.finalize());
	    this.sha1 = null;

	    var valid = true;
	    for(var i = 0; i < 20; i++)
		valid = valid && (hash[i] === this.expectedHash[i]);
	    this.valid = valid;
	    if (!valid) {
		console.warn("Invalid piece", this.pieceNumber, ":", hash, "<>", this.expectedHash);
		this.sha1pos = 0;
		for(i = 0; i < this.chunks.length; i++) {
		    if (this.chunks[i].state == 'valid')
			this.chunks[i].state = 'missing';
		}
		this.store.onPieceMissing(this.pieceNumber);
	    } else {
		this.store.onPieceValid(this.pieceNumber);
		var onValidCbs = this.onValidCbs;
		this.onValidCbs = [];
		onValidCbs.forEach(function(cb) {
		    cb();
		});
	    }
	} else
	    this.continueHashing();
    },

    continueHashing: function() {
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
			this.canHash(offset, data);
		    } else {
			console.warn("cannotHash", this.pieceNumber, ":", offset, "+", len);
			chunk.state = 'missing';
			this.store.onPieceMissing(this.pieceNumber);
		    }
		}.bind(this));
		return;
	    } else if (start < 0) {
		console.log("cannot Hash", this.chunks, this.sha1pos);
	    }
	}
    },

    read: function(offset, length, callback) {
	if (length == 0)
	    return callback();

	var pending = 0, bufs = [];
	function onRead() {
	    var i = pending;
	    pending++;
	    return function(data) {
		if (data)
		    bufs[i] = data;
		pending--;
		if (pending < 1) {
		    var b = new BufferList(bufs.filter(function(buf) {
			return !!buf;
		    }));
		    callback(b);
		}
	    };
	}
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    if (offset >= chunk.length) {
		offset -= chunk.length;
	    } else if (length > 0) {
		var len = Math.min(chunk.length - offset, length);
		this.store.readFile(chunk.path, chunk.fileOffset + offset, len, onRead());
		offset = 0;
		length -= len;
	    } else
		break;
	}
    },

    write: function(offset, data, cb) {
	if (this.valid) {
	    console.warn("Attempting to write to valid piece!");
	    return;
	}
	var canHash = this.canHash.bind(this);

	for(var i = 0; data.length > 0 && i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    if (offset >= chunk.length) {
		offset -= chunk.length;
	    } else if (offset >= 0) {
		data.take(offset);
		var length = Math.min(data.length, chunk.length);
		var buffer = data.getBufferList(0, length);
		if (chunk.state !== 'valid') {
		    (function(chunk, buffer, length) {
			 this.store.writeFile(chunk.path, chunk.fileOffset, buffer, function() {
			     chunk.state = 'written';
			     cb();
			     canHash(chunk.offset, buffer);
			 });
		     }.bind(this))(chunk, buffer, length);
		    chunk.peer = null;
		    chunk.state = 'received';
		}
		data.take(length);
	    }
	}
	if (data.length > 0)
	    console.warn("write", this.store.pieces.indexOf(this), data.length, "remain");
    },

    addOnValid: function(cb) {
	console.log("addOnValid", this.valid, this.pieceNumber);
	if (this.valid)
	    cb();
	else
	    this.onValidCbs.push(cb);
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
