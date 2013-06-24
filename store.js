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

    withFile: function(job) {
	var id = job.path.join("/");
	var t1 = Date.now();
	var workDone = 0;
	var fileQueues = this.fileQueues;
	if (fileQueues.hasOwnProperty(id)) {
	    fileQueues[id].push(job);
	    console.log("in line with", fileQueues[id].length);
	} else {
	    fileQueues[id] = [job];
	    this.withFileEntry(job.path, function(entry) {
		// console.log("fileEntry", id, entry.fullPath, entry.toURL());
		var readFile, writer;
		function workQueue() {
		    var job = fileQueues[id].shift();
		    if (!job) {
			console.log("withFile close", id, "after", Date.now() - t1, "ms:", workDone);
			delete fileQueues[id];
		    } else if (job.type === 'read') {
			workDone++;
			if (!readFile) {
			    fileQueues[id].unshift(job);
			    entry.file(function(file) {
				readFile = file;
				workQueue();
			    });
			} else {
			    var reader = new FileReader();
			    reader.onload = function() {
				job.callback(reader.result);
				workQueue();
			    };
			    reader.onerror = function(error) {
				console.error("read", error);
				job.callback();
				workQueue();
			    };
			    reader.readAsArrayBuffer(readFile.slice(job.offset, job.offset + job.length));
			}
		    } else if (job.type === 'write') {
			workDone++;
			if (!writer) {
			    fileQueues[id].unshift(job);
			    entry.createWriter(function(writer_) {
				writer = writer_;
				workQueue();
			    });
			} else {
			    writer.seek(job.offset);
			    writer.onwriteend = function() {
				job.callback();
				workQueue();
			    };
			    writer.onerror = function(error) {
				console.error("write", error);
				job.callback();
				workQueue();
			    };
			    writer.write(new Blob(job.data));
			}
		    }
		}
		workQueue();
	    });
	}
    },

    readFile: function(path, offset, length, cb) {
	this.withFile({ path: path,
			type: 'read',
			offset: offset,
			length: length,
			callback: cb
		      });
    },

    writeFile: function(path, offset, data, cb) {
	this.withFile({ path: path,
			type: 'write',
			offset: offset,
			data: data,
			callback: cb
		      });
    }
};

var CHUNK_LENGTH = Math.pow(2, 15);

function StorePiece(store, chunks, expectedHash) {
    this.store = store;
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
	if (result)
	    result.cancel = function() {
		requestedChunks.forEach(function(chunk) {
		    chunk.peer = null;
		    if (chunk.state == 'requested')
			chunk.state = 'missing';
		});
	    };
	return result;
    },

    canHash: function(offset, bufs) {
	if (offset > this.sha1pos)
	    return;
	else if (offset < this.sha1pos) {
	    bufs = new BufferList(bufs).getBuffers(this.sha1pos - offset);
	}
	// console.log("piece", this.store.pieces.indexOf(this), "canHash", offset, this.sha1pos);
	if (!this.sha1)
	    this.sha1 = new Digest.SHA1();
	var sha1 = this.sha1;
	bufs.forEach(function(buf) {
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
		console.warn("Invalid piece", hash, "<>", this.expectedHash);
		this.sha1pos = 0;
		for(i = 0; i < this.chunks.length; i++) {
		    var chunk = this.chunks[i];
		    if (chunk.state == 'valid')
			chunk.state = 'missing';
		}
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
		(function(offset) {
		     this.read(offset, len, function(data) {
			 this.canHash(offset, data.buffers);
		     }.bind(this));
		 }.bind(this))(offset);
		break;
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
	var canHash = this.canHash.bind(this);

	for(var i = 0; data.length > 0 && i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    if (offset >= chunk.length) {
		offset -= chunk.length;
	    } else if (offset == 0) {
		var length = Math.min(data.length, chunk.length);
		var bufs = data.getBuffers(0, length);
		if (chunk.state !== 'valid') {
		    (function(chunk, bufs, length) {
			 this.store.writeFile(chunk.path, chunk.fileOffset, bufs, function() {
			     chunk.state = 'written';
			     cb();
			     canHash(chunk.offset, bufs);
			 });
		     }.bind(this))(chunk, bufs, length);
		    chunk.peer = null;
		    chunk.state = 'received';
		}
		data.take(length);
	    }
	}
	if (data.length > 0)
	    console.warn("write", this.store.pieces.indexOf(this), data.length, "remain");
    }
};
