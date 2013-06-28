function Torrent(meta) {
    console.log("new Torrent", meta);
    this.name = UTF8ArrToStr(meta.info.name);
    this.pieces = Math.floor(meta.info.pieces.byteLength / 20);
    this.infoHash = meta.infoHash;
    this.peerId = "-BF000-xxxxxxxxxxxxx";
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
    if (typeof meta.info.length == 'number')
	this.files = [{ path: [name], size: meta.info.length }];
    else if (meta.info.files.__proto__.constructor == Array)
	this.files = meta.info.files.map(function(file) {
	    return { path: [name].concat(file.path.map(UTF8ArrToStr)),
		     size: file.length
		   };
	});
    else
	throw "Invalid torrent: no files";
    this.store = new Store(this.files, pieces, pieceLength);
    this.store.onPieceMissing = this.onPieceMissing.bind(this);
    this.store.onPieceValid = this.onPieceValid.bind(this);

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

    // Can defer:
    this.trackers.forEach(function(tg) { tg.start() });
    console.log("Torrent", this);

    setInterval(this.canConnectPeer.bind(this), 100);
}

Torrent.prototype = {
    canConnectPeer: function() {
	for(var i = 0; i < this.peers.length; i++) {
	    var peer = this.peers[i];
	    if (!peer.state && !peer.error) {
		peer.connect();
		break;
	    }
	}
    },

    addPeer: function(info) {
	this.peers.push(new Peer(this, info));
    },

    getBitfield: function() {
	var result = new Uint8Array(Math.ceil(this.pieces / 8));
	return result;
    },

    onPieceMissing: function(pieceNumber) {
	for(var i = 0; i < this.peers.length; i++) {
	    var peer = this.peers[i];
	    if (peer.state === 'connected' && peer.has(pieceNumber))
		peer.canRequest();
	}
    },

    onPieceValid: function(pieceNumber) {
    }
};
