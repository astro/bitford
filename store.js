var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(files, pieceLength) {
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
	this.pieces.push(new StorePiece(this, chunks));
    }
    this.fileQueues = {};

    /* TODO: start hashing */
}
Store.prototype = {
    isInterestedIn: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (piece.state !== 'complete' && peer.has(i))
		return true;
	}
	return false;
    },

    nextToDownload: function(peer, chunkLength) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    var chunk = piece.state !== 'complete' &&
		peer.has(i) &&
		piece.nextToDownload(peer, chunkLength);
	    if (chunk) {
		chunk.piece = i;
		console.log("nextToDownload", chunk);
		return chunk;
	    }
	}
	return null;
    },

    write: function(piece, offset, data) {
	if (piece < this.pieces.length)
	    this.pieces[piece].write(offset, data);
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
		console.log("fileEntry", id, entry.fullPath, entry.toURL());
		var readFile, writer;
		function workQueue() {
		    var item = fileQueues[id].shift();
		    console.log("workQueue", item);
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

function StorePiece(piece, chunks) {
    this.piece = piece;
    this.chunks = chunks.map(function(chunk) {
	// chunk.state = 'unchecked';
	chunk.state = 'missing';
	return chunk;
    });
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
		    var b = new BufferList();
		    bufs.forEach(function(buf) {
			if (buf)
			    b.append(buf);
		    });
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
		this.piece.withFile(chunk.path, 'read', function(file) {
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

    write: function(offset, data) {
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    var skip = Math.min(offset, chunk.length);
	    offset -= skip;
	    if (offset <= 0) {
		var length = Math.min(data.length, chunk.length);
		var blob = new Blob(data.getBuffers(0, length));
		this.piece.withFile(chunk.path, 'write', function(writer, cb) {
		    console.log("write", chunk, length);
		    writer.seek(chunk.offset);
		    writer.write(blob);
		    writer.onwriteend = function() {
			writer.onwriteend = null;
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
		chunk.state = 'written';
	    }
	    if (data.length <= 0) {
		this.mergeChunks();
		break;
	    }
	}
    }
};
