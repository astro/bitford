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

    /* Init Storage */
    var name = UTF8ArrToStr(meta.info.name);
    if (typeof meta.info.length == 'number')
	this.store = new Store([{ path: [name], size: meta.info.length }], pieceLength);
    else if (meta.info.files.__proto__.constructor == Array)
	this.store = new Store(meta.info.files.map(function(file) {
	    return { path: [name].concat(file.path.map(UTF8ArrToStr)),
		     size: file.length
		   };
	}), pieceLength);
    else
	throw "Invalid torrent: no files";

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
}

Torrent.prototype = {
    addPeer: function(info) {
	this.peers.push(new Peer(this, info));
    },
    getBitfield: function() {
	var result = new Uint8Array(Math.ceil(this.pieces / 8));
	return result;
    }
};
