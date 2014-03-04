function servePeer(sock, cb) {
    sock.getInfo(function(info) {
	console.log("servePeer", sock, "info", info);
	try {
	    var peer = new Peer(null, {
		ip: info.peerAddress,
		port: info.peerPort
	    });
	    peer.direction = 'incoming';
	    peer.onHandshaked = function() {
		cb(peer);
                if (peer.sock)
                    /* Not yet closed? */
		    peer.sendHandshake();
	    };
	    peer.setSock(sock);
	    peer.state = 'handshake';
	} catch (e) {
	    console.error(e);
	    sock.end();
	}
    });
}

// TODO: refactor wire protocol handling out
function Peer(torrent, info) {
    this.torrent = torrent;
    this.ip = info.ip;
    this.port = info.port;
    this.direction = 'outgoing';
    this.buffer = new BufferList();
    this.requestedChunks = [];
    this.inflightThreshold = 2;
    this.inPiecesProcessing = 0;
    this.upRate = new RateEstimator();
    this.downRate = new RateEstimator();
    this.bytesUploaded = 0;
    this.bytesDownloaded = 0;
    this.pendingChunks = [];
    // We in them
    this.interesting = false;
    this.choking = true;
    // Them in us
    this.interested = false;
    this.choked = true;
}

Peer.prototype = {
    maxProcessingThreshold: 2,

    end: function() {
	if (this.sock)
	    this.sock.end();
    },

    setSock: function(sock) {
	this.sock = sock;
	sock.onEnd = function() {
	    console.log("onEnd", this);
	    delete this.sock;
	    if (this.state !== 'error')
		this.state = 'disconnected';
	    this.discardRequestedChunks();
	    // We in them
	    this.interesting = false;
	    this.choking = true;
	    // Them in us
	    this.interested = false;
	    this.choked = true;
	}.bind(this);
	sock.onData = this.onData.bind(this);
	sock.onDrain = this.onDrain.bind(this);
	sock.readLength = 20 + 8 + 20 + 20;  // Expect handshake
	sock.resume();
    },

    connect: function() {
	this.state = 'connecting';
	connectTCP(this.ip, this.port, function(error, sock) {
	    console.log(this.ip, ":", this.port, "connectTCP", error, sock);
	    if (error) {
		this.state = 'error';
		this.error = error.message || error.toString();
	    } else {
		this.state = 'handshake';
		this.setSock(sock);
		this.sendHandshake();
	    }
	}.bind(this));
    },

    sendMessage: function(msg, prio) {
	var buffer = msg.buffer;
	upShaper.enqueue({
	    amount: buffer.byteLength,
	    prio: prio,
	    cb: function() {
		if (!this.sock)
		    return;

		// console.log(this.ip, "send", new Uint8Array(buffer));
		this.sock.write(buffer);
	    }.bind(this)
	});
    },

    sendHandshake: function() {
	// "\19BitTorrent protocol"
        this.sock.write(new Uint8Array([
            19,
            66, 105, 116, 84,
            111, 114, 114, 101,
            110, 116, 32, 112,
            114, 111, 116, 111,
            99, 111, 108
        ]));
        // Extension bitfield
        this.sock.write(new Uint8Array([
            0, 0, 0, 0,
            0, 0, 0, 0
        ]));
        // InfoHash
        this.sock.write(this.torrent.infoHash);
        // PeerId
        this.sock.write(strToUTF8Arr(this.torrent.peerId));
    },

    sendBitfield: function() {
	var bitfield = this.torrent.getBitfield();
	var msg = new Message(1 + bitfield.byteLength);
	msg.setInt8(0, 5);
	/* Copy data :( */
	for(var i = 0; i < bitfield.byteLength; i++)
	    msg.setInt8(1 + i, bitfield[i]);

	this.sendMessage(msg);
    },

    onData: function(data) {
	if (this.sock) {
	    this.sock.pause();
	    this.downShaped = true;
	} else
            return;

	downShaper.enqueue({
	    amount: data.byteLength,
	    cb: function() {
		this.downShaped = false;
		if (this.sock && this.inPiecesProcessing < this.maxProcessingThreshold)
		    this.sock.resume();
	    }.bind(this)
	});

	if (data.byteLength < 1)
	    return;
	this.buffer.append(data);

	var fail = function(msg) {
	    console.warn("sock", this.ip, ":", this.port, "fail", msg);
	    if (this.sock)
		this.sock.end();
	    this.state = 'error';
	    this.error = msg;
	}.bind(this);
	var done = false;
	do {
	    if (this.state === 'handshake' && this.buffer.length >= 20 + 8 + 20 + 20) {
		if (this.buffer.getByte(0) != 19 ||
		    UTF8ArrToStr(new Uint8Array(this.buffer.slice(1, 20))) != "BitTorrent protocol") {
		    console.warn("Handshake mismatch", UTF8ArrToStr(new Uint8Array(this.buffer.slice(0, 20))));
		    return fail("Handshake mismatch");
		}
		this.infoHash = new Uint8Array(this.buffer.slice(20 + 8, 20 + 8 + 20));
		this.peerId = new Uint8Array(this.buffer.slice(20 + 8 + 20, 20 + 8 + 20 + 20));
		this.state = 'connected';
		this.buffer.take(20 + 8 + 20 + 20);

		/* Hook for validation of incoming connections */
		console.log("handshaked", this);
		if (this.onHandshaked)
		    this.onHandshaked();
		if (!bufferEq(this.infoHash, this.torrent.infoHash))
		    return fail("InfoHash mismatch");

		/** Pre-create bitfield to allow newly start up
		 *  leechers to omit the pieces message.
		 **/
		this.bitfield = new Uint8Array(Math.ceil(this.torrent.pieces / 8));

                this.sendBitfield();
                /* Interested */
                this.interesting = true;
                this.sendMessage(new Message([2]));
                /* Choked by default */
	    } else if (this.state === 'connected' && !this.messageSize && this.buffer.length >= 4) {
		this.messageSize = this.buffer.getWord32BE(0);
		// console.log(this.ip, "messageSize", this.messageSize);
		this.buffer.take(4);
	    } else if (this.state === 'connected' && this.messageSize && this.buffer.length >= this.messageSize) {
		var msgData = this.buffer.getBufferList(0, this.messageSize);
		try {
		    this.handleMessage(msgData);
		} catch (e) {
		    console.error("Error handling message", e.stack || e, msgData);
		}
		this.buffer.take(this.messageSize);
		this.messageSize = null;
	    } else {
		done = true;
	    }
	} while(!done);

	if (this.sock) {
	    if (this.state === 'connected' && !this.messageSize) {
		this.sock.readLength = 4 - this.buffer.length;
	    } else if (this.state === 'connected' && this.messageSize) {
		this.sock.readLength = this.messageSize - this.buffer.length;
	    } else
		this.sock.readLength = undefined;
	}
    },

    handleMessage: function(data) {
	// console.log(this.ip, "handleMessage", data.getByte(0), data.length);
	var piece, offset, length;
	switch(data.getByte(0)) {
	    case 0:
		/* Choke */
		this.choked = true;
		this.discardRequestedChunks();
		break;
	    case 1:
		/* Unchoke */
		this.choked = false;
		this.canRequest();
		break;
	    case 2:
		/* Interested */
		if (!this.interested && this.choking) {
		    /* Unchoke */
		    this.sendMessage(new Message([1]));
		    this.choking = false;
		}
		this.interested = true;
		break;
	    case 3:
		/* Not interested */
		this.interested = false;
		break;
	    case 4:
		/* Have */
		piece = data.getWord32BE(1);
		if (this.bitfield && this.bitfield.length >= Math.floor(piece / 8)) {
		    this.bitfield[Math.floor(piece / 8)] |= 1 << (7 - (piece % 8));
		    this.onUpdateBitfield();
		}
		break;
	    case 5:
		/* Bitfield */
		this.bitfield = new Uint8Array(data.slice(1));
		this.onUpdateBitfield();
		break;
	    case 6:
		/* Request */
		if (!this.choking) {
		    piece = data.getWord32BE(1);
		    offset = data.getWord32BE(5);
		    length = data.getWord32BE(9);
		    this.pendingChunks.push({
			piece: piece,
			offset: offset,
			length: length
		    });
                    if (this.sock.drained)
                        this.onDrain();
		}
		break;
	    case 7:
		/* Piece */
		piece = data.getWord32BE(1);
		offset = data.getWord32BE(5);
		this.onPiece(piece, offset, data.getBufferList(9));
		break;
	    case 8:
		/* Cancel */
		piece = data.getWord32BE(1);
		offset = data.getWord32BE(5);
		length = data.getWord32BE(9);
		this.pendingChunks = this.pendingChunks.filter(function(chunk) {
		    return chunk.piece === piece &&
			chunk.offset === offset &&
			chunk.length === length;
		});
		break;
	}
    },

    onPiece: function(piece, offset, data) {
	this.inPiecesProcessing++;
	var onProcessed = function() {
	    this.inPiecesProcessing--;
	    if (this.sock && !this.downShaped && this.inPiecesProcessing < this.maxProcessingThreshold)
		this.sock.resume();
	}.bind(this);

	var chunk = this.removeRequestedChunk(piece, offset, data.length);
	if (chunk) {
	    if (chunk.timeout) {
		clearTimeout(chunk.timeout);
		chunk.timeout = null;
	    }
	} else {
	    console.warn("Received unexpected piece", piece, offset, data.length);
	}
	/* Write & resume */
	if (data && data.length > 0) {
	    this.downRate.add(data.length);
            this.bytesDownloaded += data.length;
	    this.torrent.recvData(piece, offset, data, onProcessed);
	} else
            setTimeout(onProcessed, 1);

	this.canRequest();
    },

    getDonePercent: function() {
	if (this.donePercent)
	    return this.donePercent;
	if (!this.bitfield)
	    return 0;

	var present = 0;
	for(var i = 0; i < this.bitfield.length; i++) {
	    var b = this.bitfield[i];
	    if (b == 0xFF)
		present += 8;
	    else
		for(var j = 0; j < 8; j++)
		    if (b & (1 << j))
			present++;
	}
	this.donePercent = Math.floor(100 * Math.min(1, present / this.torrent.pieces));
	return this.donePercent;
    },

    has: function(pieceIdx) {
	return this.bitfield &&
	    (pieceIdx / 8) < this.bitfield.length &&
	    !!(this.bitfield[Math.floor(pieceIdx / 8)] & (1 << (7 - (pieceIdx % 8))));
    },

    onUpdateBitfield: function() {
	this.donePercent = null;

	var interesting = this.torrent.store.isInterestedInPeer(this);
	if (interesting && !this.interesting) {
	    /* Change triggered */
	    this.interesting = true;
	    /* Interested */
	    this.sendMessage(new Message([2]));
	}
	this.interesting = interesting;
	// TODO: We'll need to send not interested as our pieces complete
	this.canRequest();

	if (!this.seeding) {
	    var seeding = true;
	    for(var i = 0; seeding && i < this.torrent.pieces.length; i++)
		seeding = this.has(i);
	    this.seeding = seeding;
	}
	/* Are we both seeders? */
	if (this.seeding && this.torrent.seeding)
	    this.end();
    },

    discardRequestedChunks: function() {
	this.requestedChunks.forEach(function(chunk) {
	    chunk.cancel();
	    if (chunk.timeout) {
		clearTimeout(chunk.timeout);
		chunk.timeout = null;
	    }
	});
	this.requestedChunks = [];
    },

    removeRequestedChunk: function(piece, offset, length) {
	for(var i = 0; i < this.requestedChunks.length; i++) {
	    var chunk = this.requestedChunks[i];
	    if (chunk.piece === piece &&
		chunk.offset === offset &&
		chunk.length === length)

		break;
	}
	if (i < this.requestedChunks.length)
	    return this.requestedChunks.splice(i, 1)[0];
	else
	    return null;
    },

    onDrain: function() {
	this.canRequest();

        if (!this.sock || !this.sock.drained)
            return;

        // console.log(this.ip, "onDrain", this.pendingChunks.length);
        var t1 = Date.now();
	var chunk;
	if ((chunk = this.pendingChunks.shift())) {
	    var piece = this.torrent.store.pieces[chunk.piece];
            console.log(this.ip, "pendingChunks.shift", chunk, "valid:", piece.valid);
	    if (piece && piece.valid) {
                var t2 = Date.now();
		piece.read(chunk.offset, chunk.length, function(data) {
                    var t3 = Date.now();
                    if (!this.sock)
                        return;

		    data = new Uint8Array(data);
		    var msg = new Message(9);
		    msg.setInt8(0, 7);  /* Piece */
                    msg.setLength(9 + data.byteLength);
		    msg.setUint32(1, chunk.piece);
		    msg.setUint32(5, chunk.offset);
                    var t4 = Date.now();
                    upShaper.enqueue({
                        amount: 7 + data.byteLength,
                        cb: function() {
                            if (!this.sock)
                                return;
                            this.sock.write(msg.buffer);
                            this.sock.write(data);
			    this.upRate.add(data.length);
                            this.bytesUploaded += data.length;
			    this.torrent.upRate.add(data.length);
			    this.torrent.bytesUploaded += data.length;
                            console.log(this.ip, "Seeded", data.length, "/", chunk.length, "in", t2 - t1, "+", t3 - t2, "+", t4 - t3, "ms", this.sock.drained);
                        }.bind(this)
                    });
		}.bind(this));
	    }
	}
    },

    canRequest: function() {
	if (this.choked || !this.sock || !this.sock.drained)
	    return;

	/* Recalc inflightThreshold according to a target delay of
	   500ms, which is really a lot. Yet we need that
	   inflightThreshold reasonably high.
	 */
	this.inflightThreshold = Math.max(2,
	    Math.ceil(this.downRate.getRate() * 0.5 / CHUNK_LENGTH));

        var chunk = true;
	while(chunk && this.requestedChunks.length < this.inflightThreshold) {
	    chunk = this.torrent.store.nextToDownload(this);
	    if (chunk) {
		this.request(chunk);
	    } else {
                /* Work stealing */
                var peer;
                var now = Date.now();
                var oldest = now, oldestIdx = null;
                for(var i = 0; i < this.torrent.peers.length; i++) {
                    peer = this.torrent.peers[i];
                    if (peer.requestedChunks[0] &&
                        peer.requestedChunks[0].time < oldest &&
                        peer.ip !== this.ip) {
    
                        oldest = peer.requestedChunks[0].time;
                        oldestIdx = i;
                    }
                }
                var age = now - oldest;
                peer = this.torrent.peers[oldestIdx];
                if (peer && age > READAHEAD_TIME) {
    
                    chunk = peer.requestedChunks[peer.requestedChunks.length - 1];
                    if (chunk && this.has(chunk.piece)) {
                        peer.requestedChunks.pop();
                        if (chunk.timeout) {
                            clearTimeout(chunk.timeout);
                            chunk.timeout = null;
                        }
                        peer.sendCancel(chunk.piece, chunk.offset, chunk.length);
                        console.log(this.ip, "stole from", peer.ip, ":", chunk, "age:", age / 1000);
                        chunk.peer = this;
                        this.request(chunk);
                    } else
                        break;
                } else
                    break;
            }
	}
    },

    request: function(chunk) {
	var piece = chunk.piece, offset = chunk.offset, length = chunk.length;
	/* Piece request */
	var msg = new Message(13);
	msg.setInt8(0, 6);
	msg.setUint32(1, piece);
	msg.setUint32(5, offset);
	msg.setUint32(9, length);
	this.sendMessage(msg);

        chunk.time = Date.now();
	chunk.timeout = setTimeout(function() {
	    chunk.timeout = null;
            console.log("Peer", this.ip, "timeout:", chunk);
	    /* Let so. else try it: */
	    chunk.cancel();
	    chunk.timeout = setTimeout(function() {
                if (this.state == 'connected') {
	            this.sendCancel(piece, offset, length);
		    this.removeRequestedChunk(piece, offset, length);
                }
	    }.bind(this), Math.ceil(READAHEAD_TIME));
	}.bind(this), Math.ceil(READAHEAD_TIME));
	this.requestedChunks.push(chunk);
    },

    choke: function() {
        this.choking = true;
        this.pendingChunks = [];
        this.sendMessage(new Message([0]));
    },

    unchoke: function() {
        this.choking = false;
        this.sendMessage(new Message([1]));
    },

    sendCancel: function(piece, offset, length) {
	if (!this.sock)
	    return;

	var msg = new Message(13);
	msg.setInt8(0, 8);
	msg.setUint32(1, piece);
	msg.setUint32(5, offset);
	msg.setUint32(9, length);
	this.sendMessage(msg);
    },

    sendHave: function(piece) {
	var msg = new Message(5);
	msg.setInt8(0, 4);
	msg.setUint32(1, piece);
	this.sendMessage(msg);
    }
};

/**
 * Outgoing packet builder
 */
function Message(len) {
    if (typeof len === 'number')
	this.buffer = new ArrayBuffer(len + 4);
    else if (len.__proto__.constructor === Array) {
	this.buffer = new Uint8Array([0, 0, 0, 0].concat(len)).buffer;
	len = this.buffer.byteLength - 4;
    }
    this.bufferView = new DataView(this.buffer);
    this.setLength(len);
}
Message.prototype = {
    setLength: function(len) {
        this.bufferView.setUint32(0, len);
    },
    setInt8: function(offset, value) {
	this.bufferView.setInt8(4 + offset, value);
    },
    setUint32: function(offset, value) {
	this.bufferView.setUint32(4 + offset, value);
    }
};

function bufferEq(b1, b2) {
    if (b1.length !== b2.length)
	return false;

    for(var i = 0; i < b1.length; i++)
	if (b1[i] !== b2[i])
	    return false;

    return true;
}

