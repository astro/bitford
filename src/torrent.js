function Torrent(meta) {
    console.log("new Torrent", meta);
    this.name = UTF8ArrToStr(meta.info.name);
    this.pieces = Math.floor(meta.info.pieces.byteLength / 20);
    this.infoHash = meta.infoHash;
    this.peerId = "-BF000-";
    while (this.peerId.length < 20) {
	var r = Math.floor(62 * Math.random()), c;
	if (r < 10)
	    c = 48 + r;  /* 0..9 */
	else if (r < 36)
	    c = 65 + r - 10;  /* A..Z */
	else if (r < 62)
	    c = 97 + r - 36;  /* a..z */
	this.peerId += String.fromCharCode(c);
    }
    this.upRate = new RateEstimator();  /* Altered by Peer */
    this.downRate = new RateEstimator();
    this.peers = [];
    var pieceLength;
    if (typeof meta.info['piece length'] == 'number')
	pieceLength = meta.info['piece length'];
    else
	throw "Invalid torrent: no piece length";
    var pieces = [];
    for(var i = 0; i < meta.info.pieces.byteLength; i += 20)
	pieces.push(new Uint8Array(meta.info.pieces.subarray(i, i + 20)));

    /* Init Storage */
    var name = UTF8ArrToStr(meta.info.name);
    var torrentSize;
    if (typeof meta.info.length == 'number') {
	torrentSize = meta.info.length;
	this.files = [{ path: [name], size: meta.info.length }];
    } else if (meta.info.files.__proto__.constructor == Array) {
	torrentSize = 0;
	this.files = meta.info.files.map(function(file) {
	    torrentSize += file.length;
	    return { path: file.path.map(UTF8ArrToStr),
		     size: file.length
		   };
	});
    } else
	throw "Invalid torrent: no files";
    this.store = new Store(this, torrentSize, pieces, pieceLength);
    this.store.onRecoveryDone = this.start.bind(this);

    this.bytesDownloaded = 0;
    this.bytesUploaded = 0;  /* Altered by Peer */

    /* Init trackers */
    if (meta['announce-list'])
	this.trackers = meta['announce-list'].map(function(urls) {
	    urls = urls.map(UTF8ArrToStr);
	    return new TrackerGroup(this, urls);
	}.bind(this));
    else if (meta.announce)
	this.trackers = [new TrackerGroup(this, [UTF8ArrToStr(meta.announce)])];
    else
	console.warn("No tracker in torrent file");

    /* Updated by connectPeerLoop() */
    this.peerStats = { connected: 0, connecting: 0 };
}

Torrent.prototype = {
    start: function() {
        this.trackers.forEach(function(tg) {
            tg.start();
        });

        this.connectPeerLoop();
        this.unchokeInterval = setInterval(
            this.tickUnchoke.bind(this), 10000);
    },

    end: function() {
	this.trackers.forEach(function(tg) {
	    tg.stop();
	});
        if (this.unchokeInterval) {
            clearInterval(this.unchokeInterval);
            this.unchokeInterval = null;
        }
	this.peers.forEach(function(peer) {
	    console.log("end peer", peer);
	    peer.end();
	});
	console.log("remove store", this.store);
	this.store.remove();
    },

    connectPeerLoop: function() {
        var candidate, connecting = 0, connected = 0;
	for(var i = 0; i < this.peers.length; i++) {
	    var peer = this.peers[i];
            if (peer.state === 'connecting' || peer.state === 'handshake')
                connecting++;
            else if (peer.state === 'connected')
                connected++;
	    else if (!candidate && !peer.state && !peer.error) {
		candidate = peer;
	    }
	}
        this.peerStats.connected = connected;
        this.peerStats.connecting = connecting;
        if (candidate && connecting < 80 && connected < 60) {
            /* Connect to another peer */
            candidate.connect();
            upShaper.enqueue({
                amount: 8192,  /* 1 Connection attempt ~ 8 KB */
                cb: this.connectPeerLoop.bind(this)
            });
        } else if (connected > 40) {
            /* Disconnect from too many peers */
            setTimeout(function() {
                candidate = undefined;
                this.peers.forEach(function(peer) {
                    if (!candidate ||
                        peer.downRate.getRate() < candidate.downRate.getRate()) {

                        candidate = peer;
                    }
                });
                if (candidate)
                    candidate.end();

                this.connectPeerLoop();
            }.bind(this), 1000);
        } else {
            /* Wait */
            setTimeout(this.connectPeerLoop.bind(this), 1000);
        }
    },

    addPeer: function(info) {
	this.peers.push(new Peer(this, info));
    },

    mayDisconnectPeers: function() {
	if (this.seeding) {
	    /* Disconnect from other seeders */
	    this.peers.forEach(function(peer) {
		if (peer.state === 'connected' && peer.seeding)
		    console.log("ending seeder", peer.ip);
		    peer.end();
	    });
	}
    },

    uploadSlots: 4,

    tickUnchoke: function() {
        var byScore = this.peers.filter(function(peer) {
            return peer.state === 'connected' &&
                !peer.seeder &&
                peer.interested;
        }).sort(function(peer1, peer2) {
            var s1 = peer1.bytesDownloaded - peer1.bytesUploaded;
            var s2 = peer2.bytesDownloaded - peer2.bytesUploaded;
            if (s1 > s2)
                return -1;
            else if (s1 < s2)
                return 1;
            else
                return (Math.random() < 0.5) ? -1 : 1;
        });
        var peer;
        for(var i = 0; i < this.uploadSlots && i < byScore.length; i++) {
            peer = byScore[i];
            if (peer.choking)
                peer.unchoke();
        }
        for(; i < byScore.length; i++) {
            peer = byScore[i];
            if (!peer.choking)
                peer.choke();
        }
    },

    getBitfield: function() {
	var result = new Uint8Array(Math.ceil(this.pieces / 8));
	var pieces = this.store.pieces;
	for(var i = 0; i < pieces.length; i++)
	    if (pieces[i].valid)
		result[Math.floor(i / 8)] |= 1 << (7 - (i % 8));
	return result;
    },

    recvData: function(piece, offset, data, cb) {
	this.downRate.add(data.length);
	this.bytesDownloaded += data.length;
	this.store.write(piece, offset, data, cb);
    },

    onPieceMissing: function(pieceNumber) {
	for(var i = 0; i < this.peers.length; i++) {
	    var peer = this.peers[i];
	    if (peer.state === 'connected' && peer.has(pieceNumber))
		peer.canRequest();
	}
    },

    onPieceValid: function(pieceNumber) {
	this.peers.forEach(function(peer) {
	    if (peer.state === 'connected')
		peer.sendHave(pieceNumber);
	});

	if (this.store.getBytesLeft() > 0)
	    this.mayRequestPeers();
	else
	    /* Become seeder */
	    this.onCompleted();
    },

    mayRequestPeers: function() {
	for(var i = 0; i < this.peers.length; i++) {
	    var peer = this.peers[i];
	    if (peer.state === 'connected')
		peer.canRequest();
	}
    },

    onCompleted: function() {
	if (this.seeding)
	    return;
	this.seeding = true;

	// tell trackers
        this.trackers.forEach(function(tg) {
            tg.request('completed');
        });

	this.mayDisconnectPeers();
    },

    /**
     * Helper for users of store.consume()
     **/
    findFilePosition: function(path) {
	var offset = 0, file, size;
	for(var i = 0; i < this.files.length; i++) {
	    var file = this.files[i];
	    if (arrayEq(file.path, path)) {
		break;
	    } else {
	        offset += file.size;
	        file = undefined;
            }
	}
        if (file) {
            return {
                file: file,
                offset: offset,
                size: file.size
            };
        }
    }
};
