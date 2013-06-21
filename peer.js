var MAX_REQS_INFLIGHT = 10;
var REQ_LENGTH = Math.pow(2, 15);

function Peer(torrent, info) {
    this.torrent = torrent;
    this.ip = info.ip;
    this.port = info.port;
    this.direction = 'outgoing';
    this.buffer = new BufferList();
    this.requestedChunks = [];
    // We in them
    this.interesting = false;
    this.choking = true;
    // Them in us
    this.interested = false;
    this.choked = true;

    console.log("Connect peer", this.ip, ":", this.port);
    this.connect();
}

Peer.prototype = {
    connect: function() {
	this.state = 'connecting';
	connectTCP(this.ip, this.port, function(error, sock) {
	    console.log(this.ip, "connectTCP", error, sock);
	    if (error) {
		this.state = 'error';
		this.error = error.message || error.toString();
	    } else {
		this.state = 'handshake';
		this.sock = sock;
		sock.onEnd = function() {
		    delete this.sock;
		    this.state = 'disconnected';
		}.bind(this);
		sock.onData = this.onData.bind(this);
		this.sendHandshake();
	    }
	}.bind(this));
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

    sendLength: function(l) {
	this.sock.write(new Uint8Array([
	    (l >> 24) & 0xff,
	    (l >> 16) & 0xff,
	    (l >> 8) & 0xff,
	    l & 0xff
	]));
    },

    sendBitfield: function() {
	var bitfield = this.torrent.getBitfield();
	this.sendLength(1 + bitfield.byteLength);
	this.sock.write(new Uint8Array([5]));
	this.sock.write(bitfield);
    },

    onData: function(data) {
	this.buffer.append(data);

	var fail = function(msg) {
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
		for(var i = 0; i < 20; i++) {
		    if (this.buffer.getByte(20 + 8 + i) != this.torrent.infoHash[i])
			return fail("InfoHash mismatch");
		}
		this.peerId = this.buffer.slice(20 + 8 + 20, 20 + 8 + 20 + 20);
		this.sendBitfield();
		this.state = 'connected';
		this.buffer.take(20 + 8 + 20 + 20);
	    } else if (this.state === 'connected' && !this.messageSize && this.buffer.length >= 4) {
		this.messageSize = this.buffer.getWord32BE(0);
		this.buffer.take(4);
	    } else if (this.state === 'connected' && this.messageSize && this.buffer.length >= this.messageSize) {
		this.handleMessage(this.buffer.getBufferList(0, this.messageSize));
		this.buffer.take(this.messageSize);
		this.messageSize = null;
	    } else
		done = true;
	} while(!done);
    },

    handleMessage: function(data) {
	console.log(this.ip, "handleMessage", data.getByte(0), data.length);
	var piece;
	switch(data.getByte(0)) {
	    case 0:
		/* Choke */
		this.choked = true;
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
		if (this.bitfield.length >= Math.floor(piece / 8)) {
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
		break;
	    case 7:
		/* Piece */
		piece = data.getWord32BE(1);
		var offset = data.getWord32BE(5);
		this.requestedChunks = this.requestedChunks.filter(function(chunk) {
		    return chunk.piece !== piece || chunk.offset !== offset;
		});
		this.onPiece(piece, offset, data.getBufferList(9));
		this.canRequest();
		break;
	    case 8:
		/* Cancel */
		break;
	}
    },

    onPiece: function(piece, offset, data) {
	console.log(this.ip, "piece", piece, ":", offset, "+", data.length);
	this.torrent.store.write(piece, offset, data);
    },

    getDonePercent: function() {
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
	return Math.floor(100 * Math.max(1, present / this.torrent.pieces));
    },

    has: function(pieceIdx) {
	return !!(this.bitfield[Math.floor(pieceIdx / 8)] & (1 << (7 - (pieceIdx % 8))));
    },

    onUpdateBitfield: function() {
	var interesting = this.torrent.store.isInterestedIn(this);
	if (interesting && !this.interesting) {
	    /* Change triggered */
	    this.interesting = true;
	    this.sendLength(1);
	    /* Interested */
	    this.sock.write(new Uint8Array([2]));
	}
	this.interesting = interesting;
	// TODO: We'll need to send not interested as our pieces complete
    },

    canRequest: function() {
	while(!this.choked && this.requestedChunks.length < MAX_REQS_INFLIGHT) {
	    var chunk = this.torrent.store.nextToDownload(this, REQ_LENGTH);
	    if (!chunk)
		break;

	    this.sendLength(13);
	    var piece = chunk.piece, offset = chunk.offset, length = chunk.length;
	    this.sock.write(new Uint8Array([
		6,
		(piece >> 24) & 0xff, (piece >> 16) & 0xff, (piece >> 8) & 0xff, piece & 0xff,
		(offset >> 24) & 0xff, (offset >> 16) & 0xff, (offset >> 8) & 0xff, offset & 0xff,
		(length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff
	    ]));
	    this.requestedChunks.push(chunk);
	}
    }
};
