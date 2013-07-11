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

function Peer(torrent, info) {
    this.torrent = torrent;
    this.ip = info.ip;
    this.port = info.port;
    this.direction = 'outgoing';
    this.buffer = new BufferList();
    this.requestedChunks = [];
    this.inflightThreshold = 10;
    this.inPiecesProcessing = 0;
    this.rate = new RateEstimator();
    this.pendingChunks = [];
    // We in them
    this.interesting = false;
    this.choking = true;
    // Them in us
    this.interested = false;
    this.choked = true;
}

Peer.prototype = {
    end: function() {
	if (this.sock)
	    this.sock.end();
    },

    setSock: function(sock) {
	this.sock = sock;
	sock.onEnd = function() {
	    delete this.sock;
	    this.state = 'disconnected';
	    this.discardRequestedChunks();
	}.bind(this);
	sock.onData = this.onData.bind(this);
	sock.onDrain = this.onDrain.bind(this);
	sock.resume();
    },

    connect: function() {
	this.state = 'connecting';
	connectTCP(this.ip, this.port, function(error, sock) {
	    console.log(this.ip, "connectTCP", error, sock);
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

    sendLength: function(l) {
	this.sock.write(new Uint8Array([
	    (l >> 24) & 0xff,
	    (l >> 16) & 0xff,
	    (l >> 8) & 0xff,
	    l & 0xff
	]));
    },

    sendMessage: function(buffers, prio) {
	var len = buffers.byteLength || buffers.length;
	upShaper.enqueue({
	    amount: 4 + len,
	    prio: prio,
	    cb: function() {
		this.sendLength(len);
		if (buffers.getBuffers)
		    buffers.getBuffers().forEach(function(buf) {
			this.sock.write(buf);
		    }.bind(this));
		else
		    this.sock.write(buffers);
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
	this.sendMessage(new BufferList([
	    new Uint8Array([5]),
	    bitfield
	]));
    },

    onData: function(data) {
	if (this.sock)
	    this.sock.pause();
	this.downShaped = true;
	downShaper.enqueue({
	    amount: data.byteLength,
	    cb: function() {
		this.downShaped = false;
		if (this.sock && this.inPiecesProcessing < this.inflightThreshold)
		    this.sock.resume();
	    }.bind(this)
	});

	if (data.byteLength < 1)
	    return;
	this.buffer.append(data);
	this.rate.add(data.byteLength);

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

		this.sendBitfield();
		/* Interested */
		this.sendMessage(new Uint8Array([2]));
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
	    } else
		done = true;
	} while(!done);
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
	    if (this.sock && !this.downShaped && this.inPiecesProcessing < this.inflightThreshold)
		this.sock.resume();
	}.bind(this);

	var chunk = this.removeRequestedChunk(piece, offset, data.length);
	if (chunk) {
	    var delay = Date.now() - chunk.sendTime;
	    if (!this.minDelay)
		this.minDelay = delay;
	    else if (delay < this.minDelay) {
		this.minDelay = 0.8 * this.minDelay + 0.2 * delay;
	    } else if (delay < 1.5 * this.minDelay) {
	    } else {
		this.minDelay = 0.99 * this.minDelay + 0.01 * delay;
	    }
	    if (chunk.timeout) {
		clearTimeout(chunk.timeout);
		chunk.timeout = null;
	    }

	    /* Write & resume */
	    this.torrent.recvData(piece, offset, data, onProcessed);
	} else {
	    console.warn("Received unexpected piece", piece, offset, data.length);
	    onProcessed();
	}
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
	this.donePercent = Math.floor(100 * Math.max(1, present / this.torrent.pieces));
	return this.donePercent;
    },

    has: function(pieceIdx) {
	return this.bitfield &&
	    (pieceIdx / 8) < this.bitfield.length &&
	    !!(this.bitfield[Math.floor(pieceIdx / 8)] & (1 << (7 - (pieceIdx % 8))));
    },

    onUpdateBitfield: function() {
	this.donePercent = null;

	var interesting = this.torrent.store.isInterestedIn(this);
	if (interesting && !this.interesting) {
	    /* Change triggered */
	    this.interesting = true;
	    /* Interested */
	    this.sendMessage(new Uint8Array([2]));
	}
	this.interesting = interesting;
	// TODO: We'll need to send not interested as our pieces complete
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
    },

    canRequest: function() {
	if (this.choked || !this.sock || !this.sock.drained)
	    return;

	while(this.requestedChunks.length < this.inflightThreshold) {
	    var chunk = this.torrent.store.nextToDownload(this);
	    if (chunk)
		this.request(chunk);
	    else {
		/* Work stealing */
		var maxReqs = 0, maxReqsIdx = null;
		for(var i = 0; i < this.torrent.peers.length; i++) {
		    var reqs = this.torrent.peers[i].requestedChunks.length;
		    if (reqs > maxReqs) {
			maxReqs = reqs;
			maxReqsIdx = i;
		    }
		}
		if (maxReqs > 2 && maxReqs >= 2 * this.requestedChunks.length) {
		    var peer = this.torrent.peers[maxReqsIdx];
		    console.log("peer", peer.ip, "has max reqs:", maxReqs);
		    chunk = peer.requestedChunks.pop();
		    peer.sendCancel(chunk.piece, chunk.offset, chunk.length);
		    if (chunk) {
			console.log(this.ip, "stole from", peer.ip, ":", chunk);
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
	chunk.sendTime = Date.now();
	this.sendMessage(new Uint8Array([
	    6,
	    (piece >> 24) & 0xff, (piece >> 16) & 0xff, (piece >> 8) & 0xff, piece & 0xff,
	    (offset >> 24) & 0xff, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff,
	    (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff
	]));

	var delay = this.minDelay || 500;
	chunk.timeout = setTimeout(function() {
	    console.log(this.ip, "chunk timeout", chunk.piece, ":", chunk.offset);
	    chunk.timeout = null;

	    /* Cancel */
	    this.sendCancel(piece, offset, length);

	    if (this.minDelay) {
		/* Give some time to still come in */
		setTimeout(function() {
		    this.removeRequestedChunk(piece, offset, length);
		    chunk.cancel();
		}.bind(this), 2 * delay);
	    } else {
		this.discardRequestedChunks();
		if (this.sock)
		    this.sock.end();
	    }
	}.bind(this), 1.5 * this.inflightThreshold * delay);
	this.requestedChunks.push(chunk);
    },

    sendCancel: function(piece, offset, length) {
	if (!this.sock)
	    return;

	this.sendMessage(new Uint8Array([
	    8,
	    (piece >> 24) & 0xff, (piece >> 16) & 0xff, (piece >> 8) & 0xff, piece & 0xff,
	    (offset >> 24) & 0xff, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff,
	    (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff
	]));
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

