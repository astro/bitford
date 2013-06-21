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
    var fileOffset = 0;
    while(files.length > 0) {
	var pieceOffset = 0;
	var chunks = [];
	/* ...from files */
	while(pieceOffset < pieceLength && files.length > 0) {
	    var length = Math.min(pieceLength - pieceOffset, files[0].size - fileOffset);
	    chunks.push({ path: files[0].path,
			  fileOffset: fileOffset,
			  offset: pieceOffset,
			  length: length });
	    pieceOffset += length;
	    fileOffset += length;
	    if (fileOffset >= files[0].size) {
		files.shift();
		fileOffset = 0;
	    }
	}
	this.pieces.push(new StorePiece(this, chunks, pieceHashes[this.pieces.length]));
    }
    this.fileQueues = {};

    /* TODO: start hashing */
}
Store.prototype = {
    fileQueuesSize: function() {
	var total = 0;
	for(var id in this.fileQueues)
	    if (this.fileQueues.hasOwnProperty(id))
		total += this.fileQueues[id].length;
	return total;
    },

    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.state !== 'valid' && peer.has(i))
		return true;
	}
	return false;
    },

    nextToDownload: function(peer, chunkLength) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    var chunk = piece.state !== 'valid' &&
		peer.has(i) &&
		piece.nextToDownload(peer, chunkLength);
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

    write: function(piece, offset, data, cb) {
	if (piece < this.pieces.length)
	    this.pieces[piece].write(offset, data, cb);
    },

    /* walks path parts asynchronously */
    withFileEntry: function(parts, cb) {
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

    withFile: function(parts, type, cb) {
	var id = parts.join("/");
	var fileQueues = this.fileQueues;
	var item = { type: type, callback: cb };
	if (fileQueues.hasOwnProperty(id)) {
	    fileQueues[id].push(item);
	} else {
	    fileQueues[id] = [item];
	    this.withFileEntry(parts, function(entry) {
		// console.log("fileEntry", id, entry.fullPath, entry.toURL());
		var readFile, writer;
		function workQueue() {
		    var item = fileQueues[id].shift();
		    if (!item) {
			delete fileQueues[id];
		    } else if (item.type === 'read') {
			if (writer)
			    writer = null;
			if (readFile)
			    item.callback(readFile, workQueue);
			else
			    entry.file(function(file) {
				readFile = file;
				item.callback(readFile, workQueue);
			    });
		    } else if (item.type === 'write') {
			if (readFile)
			    readFile = null;
			if (writer)
			    item.callback(writer, workQueue);
			else
			    entry.createWriter(function(writer_) {
				writer = writer_;
				item.callback(writer, workQueue);
			    });
		    }
		}
		workQueue();
	    });
	}
    }
};

function StorePiece(store, chunks, expectedHash) {
    this.store = store;
    this.chunks = chunks.map(function(chunk) {
	// chunk.state = 'unchecked';
	chunk.state = 'missing';
	return chunk;
    });
    this.expectedHash = expectedHash;
    this.sha1pos = 0;
}
StorePiece.prototype = {
    state: 'missing',


    /* House-keeping to be called when anything updates */
    mergeChunks: function() {
	/* Re-sort by offset */
	var chunks = this.chunks.sort(function(chunk1, chunk2) {
	    return chunk1.offset - chunk2.offset;
	});
	/* Coalesce subsequent chunks */
	var newChunks = [], current;
	for(var i = 0; i < chunks.length; i++) {
	    var chunk = chunks[i];
	    if (current &&
		current.path === chunk.path &&
		current.state !== 'requested' &&
		current.state === chunk.state &&
		current.offset + current.length == chunk.offset) {

		current.length += chunk.length;
	    } else {
		current = chunk;
		newChunks.push(current);
	    }
	}
	/* Eliminate zero-length */
	this.chunks = newChunks.filter(function(chunk) {
	    return chunk.length > 0;
	});
    },

    nextToDownload: function(peer, chunkLength) {
	var result, remain = chunkLength;
	for(var i = 0; i < this.chunks.length && remain > 0; i++) {
	    var chunk = this.chunks[i];
	    if (chunk.state === 'missing') {
		chunk.state = 'requested';
		var length = Math.min(chunk.length, remain);
		remain -= length;
		if (!result)
		    result = {
			offset: chunk.offset,
			length: length
		    };
		else
		    result.length += length;
		if (length < chunk.length) {
		    /* Range ends in the middle of chunk, break it */
		    this.chunks.push({
			state: 'missing',
			path: chunk.path,
			fileOffset: chunk.fileOffset + length,
			offset: chunk.offset + length,
			length: chunk.length - length
		    });
		    chunk.length = length;
		}
	    } else if (result)
		/* No subsequent missing, return now */
		break;
	}
	if (result)
	    this.mergeChunks();
	return result;
    },

    canHash: function(offset, bufs) {
	if (offset > this.sha1pos)
	    return;
	else if (offset < this.sha1pos) {
	    bufs = new BufferList(bufs).getBuffers(this.sha1pos - offset);
	}
	console.log("canHash", this.store.pieces.indexOf(this), offset, "/", this.store.pieceLength, "sha1pos:", this.sha1pos, this.chunks);
	if (!this.sha1)
	    this.sha1 = new Digest.SHA1();
	var sha1 = this.sha1;
	bufs.forEach(function(buf) {
	    sha1.update(buf);
	    this.sha1pos += buf.byteLength;
	}.bind(this));
	if (this.sha1pos >= this.store.pieceLength) {
	    var hash = new Uint8Array(this.sha1.finalize());
	    delete this.sha1;

	    var valid = true;
	    for(var i = 0; i < 20; i++)
		valid = valid && (hash[i] === this.expectedHash[i]);
	    if (!valid)
		console.warn("Invalid piece", hash, "<>", this.expectedHash);
	    this.valid = valid;
	    var newState = valid ? 'valid' : 'missing';
	    for(i = 0; i < this.chunks.length; i++) {
		var chunk = this.chunks[i];
		if (chunk.state == 'written')
		    chunk.state = newState;
	    }
	}

	this.continueHashing();
    },

    continueHashing: function() {
	for(var i = 0;
	    i < this.chunks.length &&
	    this.chunks[i].state == 'written' &&
	    this.chunks[i].offset <= this.sha1pos;
	    i++) {

	    var chunk = this.chunks[i];
	    var start = this.sha1pos - chunk.offset;
	    if (start > 0 && start < chunk.length) {
		var l = chunk.length - start;
		this.read(chunk.offset + start, l, function(data) {
		    this.canHash(chunk.offset + start, [data]);
		}.bind(this));
		break;
	    }
	}
    },

    read: function(offset, length, callback) {
	if (length == 0)
	    callback();

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
	    } else if (l > 0) {
		var l = Math.min(chunk.length, length);
		this.store.withFile(chunk.path, 'read', function(file) {
		    var reader = new FileReader();
		    var cb = onRead();
		    reader.onloadend = function() {
			cb(reader.result);
		    };
		    reader.onerror = function() {
			cb();
		    };
		    reader.readAsArrayBuffer(file.slice(chunk.fileOffset + offset, l));
		});
		offset = 0;
		length -= l;
	    } else
		break;
	}
    },

    write: function(offset, data, cb) {
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    var skip = Math.min(offset, chunk.length);
	    offset -= skip;
	    if (offset <= 0) {
		var length = Math.min(data.length, chunk.length);
		var bufs = data.getBuffers(0, length);
		var canHash = this.canHash.bind(this);
		var blob = new Blob(bufs);
		this.store.withFile(chunk.path, 'write', function(writer, releaseFile) {
		    // console.log("write", chunk, length);
		    writer.seek(chunk.fileOffset);
		    writer.write(blob);
		    writer.onwriteend = function() {
			writer.onwriteend = null;
			releaseFile();

			chunk.state = 'written';
			canHash(chunk.offset, bufs);

			cb();
		    };
		});
		data.take(length);

		if (chunk.length > length) {
		    this.chunks.push({
			state: chunk.state,
			path: chunk.path,
			fileOffset: chunk.fileOffset + length,
			offset: chunk.offset + length,
			length: chunk.length - length
		    });
		    chunk.length = length;
		}
		chunk.state = 'received';
	    }
	    if (data.length <= 0) {
		this.mergeChunks();
		break;
	    }
	}
    }
};
