var READAHEAD_TIME = 3000;

var requestFileSystem_ = window.requestFileSystem ||
    window.webkitRequestFileSystem;
var PersistentStorage_ = navigator.PersistentStorage ||
    navigator.webkitPersistentStorage;

function Store(torrent, torrentSize, pieceHashes, pieceLength) {
    this.torrent = torrent;
    this.size = torrentSize;
    this.pieceLength = pieceLength;

    var infoHashHex = bufferToHex(torrent.infoHash);
    this.backend = new StoreBackend(infoHashHex, this.onExisting.bind(this));
    this.backend.onRecoveryDone = function() {
        /* pass up to torrent */
        this.onRecoveryDone();
    }.bind(this);

    this.pieces = [];
    /* Build pieces... */
    for(var offset = 0; offset < torrentSize; offset += pieceLength) {
	var length = Math.min(pieceLength, torrentSize - offset);
	var pieceNumber = this.pieces.length;
	this.pieces.push(new StorePiece(this, pieceNumber, length, pieceHashes[pieceNumber]));
    }

    /* (changed dynamically) */
    this.piecesReadahead = 2;
    this.interestingPieces = [];
    /* Upper bound for interestingPieces (changed dynamically) */
    this.interestingPiecesThreshold = 4;

    this.sha1Worker = new SHA1Worker();
}
Store.prototype = {
    /* Called back by StoreBackend() when initializing (recovery) */
    onExisting: function(offset, data, cb) {
	var pending = 1;
	var done = function() {
	    pending--;
	    if (pending < 1) {
		console.log("existing", offset, "done", pending);
		//this.mayHash();
		if (cb)
		    cb();
	    }
	}.bind(this);

	var length = data.byteLength;
	for(var i = Math.floor(offset / this.pieceLength);
	    i < this.pieces.length && i < (offset + length) / this.pieceLength;
	    i++) {

	    var pieceOffset = i * this.pieceLength;
	    var piece = this.pieces[i];
	    for(var j = 0; j < piece.chunks.length; j++) {
		var chunk = piece.chunks[j];
		if (pieceOffset + chunk.offset === offset)
                    break;
            }
            if (j < piece.chunks.length) {
                var start = j;
                for(j++; j < piece.chunks.length; j++) {
		    chunk = piece.chunks[j];
		    if (pieceOffset + chunk.offset >= offset + length)
                        break;
                }
                var stop = j;
                var newChunk = {
	            offset: offset - pieceOffset,
	            length: length,
	            state: 'written'
                };
                console.log("splice", i, ": from", start, "to", stop, "into", pieceOffset, "+", length);
                piece.chunks.splice(start, stop - start, newChunk);
	    }
	    pending++;
	    piece.canHash(offset - pieceOffset, new BufferList([data]), done);
            pending++;
            piece.continueHashing(done);
	}
        done();
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

    isInterestedInPeer: function(peer) {
	for(var i = 0; i < this.pieces.length; i++) {
	    var piece = this.pieces[i];
	    if (!piece.valid && peer.has(i))
		return true;
	}
	return false;
    },

    isCurrentlyInterestedInPiece: function(pieceNumber) {
	for(var i = 0; i < this.interestingPieces.length; i++) {
            if (this.interestingPieces[i].pieceNumber === pieceNumber)
                return true;
	}
	return false;
    },

    nextToDownload: function(peer) {
        var piece;
	for(var i = 0; i < this.interestingPieces.length; i++) {
	    piece = this.interestingPieces[i];
	    var chunk =
		peer.has(piece.pieceNumber) &&
		piece.nextToDownload(peer);
	    if (chunk) {
                /* Found candidate! */
		return chunk;
            }
	}

	/* these are proportional to torrent rate,
	   to have piece stealing in time
	*/
	var readaheadBytes = READAHEAD_TIME * this.torrent.downRate.getRate() / 1000;
	this.piecesReadahead = Math.ceil(Math.max(512 * 1024, readaheadBytes) / this.pieceLength);
        this.interestingPiecesThreshold = 2 * this.piecesReadahead;
        var t1 = Date.now();

        if (this.interestingPieces.length < this.interestingPiecesThreshold &&
            (piece = this.findInterestingPiece(peer))) {
            var t2 = Date.now();
            console.log("new interesting", piece, "in", t2 - t1, "ms");
            this.interestingPieces.push(piece);
            setTimeout(this.onPieceMissing.bind(this, piece.pieceNumber), 1);

            if (!peer.has(piece.pieceNumber)) {
                console.warn("Found interesting piece for peer who doesn't have it", peer.ip, piece.pieceNumber);
            } else {
                return piece.nextToDownload(peer);
            }
        } else
            console.log("cannot find interesting pieces for", peer.ip, "currently:", this.interestingPieces.length, "/", this.interestingPiecesThreshold);

	return null;
    },

    findInterestingPiece: function(hintPeer) {
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
	var idxs = Object.keys(rarity).
            sort(function(idx1, idx2) {
	        var r1 = rarity[idx1], r2 = rarity[idx2];
	        if (r1 === r2)
		    return Math.random() - 0.5;
	        else
		    return r2 - r1;
	    });
	for(i = 0; i < idxs.length; i++) {
	    var idx = parseInt(idxs[i], 10);
	    piece = this.pieces[idx];
            if (!this.isCurrentlyInterestedInPiece(idx)) {
                /* Found! */
                return piece;
            }
	}

        /* Peer has nothing for us
           TODO: work on interested state
        */
        return null;
    },

    onPieceMissing: function(idx) {
	this.torrent.onPieceMissing(idx);
    },

    onPieceValid: function(idx) {
	console.log("piece",idx,"valid");
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
	if (typeof this.bytesLeft === 'number')
	    return this.bytesLeft;

	var result = 0;
	for(var i = 0; i < this.pieces.length; i++) {
	    if (!this.pieces[i].valid) {
		this.pieces[i].chunks.forEach(function(chunk) {
		    if (chunk.state === 'missing' || chunk.state === 'requested')
			result += chunk.length;
		});
	    }
	}
	this.bytesLeft = result;
	return result;
    },

    /**
     * A read that can take really long; prioritize pieces, wait until
     * they're valid 
     */
    consume: function(offset, cb) {
	var pieceNumber = Math.floor(offset / this.pieceLength);
        var pieceOffset = pieceNumber * this.pieceLength;
	var piece = this.pieces[pieceNumber];
	if (piece) {
	    piece.addOnValid(function() {
		var chunkOffset = offset - pieceNumber * this.pieceLength;
		var chunk;
		for(var i = 0; i < piece.chunks.length; i++) {
		    chunk = piece.chunks[i];
		    if (chunk.offset <= chunkOffset && chunk.offset + chunk.length > chunkOffset)
			break;
		    chunk = undefined;
		}
		if (chunk && chunk.data) {
		    var data = chunk.data;
		    if (chunk.offset < chunkOffset) {
			data = data.getBufferList(chunkOffset - chunk.offset);
                    }
		    data.readAsArrayBuffer(cb);
		} else if (chunk) {
                    var absoluteChunkOffset = pieceOffset + chunk.offset;
		    this.backend.read(absoluteChunkOffset, function(data) {
			if (absoluteChunkOffset < offset) {
			    data = data.slice(offset - absoluteChunkOffset);
                        }
			cb(data);
		    });
		} else {
		    cb();
		}
	    }.bind(this));
	    
	    /* Interest for readahead */
	    var readahead = [];
            var piecesReadahead = Math.max(2, this.piecesReadahead);
	    for(i = piece.pieceNumber; piecesReadahead > 0 && i < this.pieces.length; i++) {
		if (!this.pieces[i].valid) {
		    piecesReadahead--;
		    readahead.push(i);
		}
	    }
	    this.interestingPieces = readahead.map(function(i) {
		return this.pieces[i];
	    }.bind(this)).concat(this.interestingPieces.filter(function(piece) {
		return readahead.indexOf(piece.pieceNumber) === -1;
	    }));
	} else {
	    console.warn("consume: offset exceeded torrent length:", offset);
	    cb();
	}
    },

    write: function(pieceNumber, offset, data, cb) {
	if (pieceNumber < this.pieces.length) {
	    var piece = this.pieces[pieceNumber];
	    if (piece.valid) {
		/* Attempting to write to valid piece
                 * (possibly timed out and requested with another peer)
                 */
                cb();
		return;
	    }

	    piece.write(offset, data, function() {
		piece.continueHashing(cb);
	    });
	    this.bytesLeft = null;
	} else
	    cb();
    }
};

var CHUNK_LENGTH = Math.pow(2, 14);  /* 16 KB */

function StorePiece(store, pieceNumber, pieceLength, expectedHash) {
    this.store = store;
    this.pieceNumber = pieceNumber;
    /* Create chunks */
    this.chunks = [];
    for(var offset = 0; offset < pieceLength; offset += CHUNK_LENGTH) {
	var length = Math.min(pieceLength - offset, CHUNK_LENGTH);
	this.chunks.push({
	    offset: offset,
	    length: length,
	    state: 'missing'
	});
    }

    this.expectedHash = expectedHash;
    this.sha1pos = 0;

    this.onValidCbs = [];
}
StorePiece.prototype = {
    /* TODO: simplify, all chunks are equally sized now */
    nextToDownload: function(peer) {
        if (this.valid)
            /* No need to */
            return null;

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
	else {
            var result = new BufferList();
            var stack = new Error("Empty read for " + offset + "+" + length).stack;
            var read = function(offset, length) {
	        this.store.backend.read(
		    this.pieceNumber * this.store.pieceLength + offset,
		    function(data) {
                        if (!data || data.byteLength < 1) {
                            console.error(stack);
                            return cb();
                        }

                        if (data.byteLength > length)
                            data = data.slice(0, length);
                        result.append(data);

                        if (length > data.byteLength && data.byteLength > 0) {
                            read(offset + data.byteLength, length - data.byteLength);
                        } else {
                            result.readAsArrayBuffer(cb);
                        }
                    });
            }.bind(this);
            read(offset, length);
        }
    },

    write: function(offset, data, cb) {
	for(var i = 0; i < this.chunks.length; i++) {
	    var chunk = this.chunks[i];
	    // TODO: may need to write to multiple chunks in multi-file torrents
	    if (chunk.offset === offset &&
		chunk.length === data.length &&
		(chunk.state === 'missing' || chunk.state === 'requested')) {
		
		chunk.state = 'received';
		chunk.data = data;
		this.canHash(offset, data, cb);
		return;
	    }
	    else if (chunk.offset > offset)
		break;
	}
	cb();
    },

    canHash: function(offset, data, cb) {
	if (offset > this.sha1pos) {
	    /* To be picked up again when preceding data has been hashed */
	    return cb();
	} else if (offset < this.sha1pos) {
	    data.take(this.sha1pos - offset);
	}
	// console.log("piece", this.store.pieces.indexOf(this), "canHash", offset, this.sha1pos);
	var pending = 1;
	function onDone() {
	    pending--;
	    if (pending < 1 && cb)
		cb();
	}
	data.getBuffers().forEach(function(buf) {
	    this.sha1pos += buf.byteLength;
	    this.store.sha1Worker.update(this.pieceNumber, buf, onDone);
	    pending++;
	    /* buf is neutered here, don't reuse data */
	}.bind(this));

	var chunk;
	for(var i = 0; i < this.chunks.length; i++) {
	    chunk = this.chunks[i];
	    if (chunk.offset + chunk.length > this.sha1pos) {
		/* Found a piece that follows */
		break;
	    } else if (chunk.offset + chunk.length <= this.sha1pos) {
                if (chunk.state !== 'written')
		    chunk.state = 'valid';
	    }
	}
	if (i >= this.chunks.length) {
	    /* No piece followed, validate hash */
	    this.store.sha1Worker.finalize(this.pieceNumber, function(hash) {
		this.onHashed(hash, onDone);
	    }.bind(this));
	} else {
            onDone();
        }
    },

    continueHashing: function(cb) {
	for(var i = 0;
	    i < this.chunks.length &&
	    (['received', 'valid', 'written'].indexOf(this.chunks[i].state) >= 0) &&
	    this.chunks[i].offset <= this.sha1pos;
	    i++) {

	    var chunk = this.chunks[i];
	    var start = this.sha1pos - chunk.offset;
	    if (start >= 0 && start < chunk.length) {
		var offset = chunk.offset + start;
		if (chunk.data && chunk.data.length > 0) {
		    this.canHash(offset, chunk.data, function() {
			if (i === this.chunks.length - 1)
			    cb();
			else
			    this.continueHashing(cb);
		    }.bind(this));
		} else {
		    /* This path will only be taken if recovery found
		     * stored data for a not yet valid chunk
		     */
		    this.read(offset, function(data) {
			if (data.length > 0) {
			    this.canHash(offset, data, cb);
			} else {
			    console.warn("cannotHash", this.pieceNumber, ":", this.chunks[i]);
			    chunk.state = 'missing';
			    this.store.onPieceMissing(this.pieceNumber);
			    cb();
			}
		    }.bind(this));
		}
		return;
	    } else if (start < 0) {
		console.log("cannot Hash", this.chunks, this.sha1pos);
	    }
	}
	cb();
    },

    onHashed: function(hash, cb) {
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
		    console.error("onValidCb", this.pieceNumber, e.stack);
		}
	    }.bind(this));
	
	    /* Drop memory storage just after onValidCbs have been run */
	    this.writeToBackend(cb);
	}
    },

    addOnValid: function(cb) {
	if (this.valid)
	    cb();
	else {
	    this.onValidCbs.push(cb);
	    this.store.onPieceMissing(this.pieceNumber);
	}
    },

    /**
     * Persist when piece has gone valid
     **/
    writeToBackend: function(cb) {
	var storeChunkLength = Math.min(512 * 1024, this.store.pieceLength);
	var i;
	
	/* Find first data */
	for(i = 0; i < this.chunks.length && !this.chunks[i].data; i++) {
	}
	if (i >= this.chunks.length) {
	    /* All done */
	    // console.log("Piece", this.pieceNumber, "seems fully persisted");
	    return cb();
	}
	/* i now points to the first chunk that has data */
	var i1 = i;

	var offset = this.chunks[i].offset;
	var length = this.chunks[i].data.length;
	var chunks = [this.chunks[i]];
	/* Collect succeeding chunks until storeChunkLength */
	for(i++; length < storeChunkLength && i < this.chunks.length; i++) {
	    length += this.chunks[i].data.length;
	    chunks.push(this.chunks[i]);
	}
        chunks.forEach(function(chunk) {
            chunk.state = 'writing';
        });
	/* Concatenate */
	var reader = new FileReader();
	reader.onload = function() {
	    // console.log("Write to", this.pieceNumber, "+", offset, ":", reader.result.byteLength, "/", length, "bytes");
	    this.store.backend.write(
		this.pieceNumber * this.store.pieceLength + offset,
		reader.result, function() {
	            var newChunk = {
	                offset: chunks[0].offset,
	                length: length,
	                state: 'written'
	            };
		    this.chunks.splice(i1, chunks.length, newChunk);
		    /* loop (because we write only up to storeChunkLength */
		    this.writeToBackend(cb);
		}.bind(this));
	}.bind(this);
        reader.onerror = function() {
            cb();
        };
	var buffers = [].concat.apply([], chunks.map(function(chunk) {
	    return chunk.data.getBuffers();
	}));
	reader.readAsArrayBuffer(new Blob(buffers));
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
