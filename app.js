"use strict";

var app = angular.module('Bitford', []);

app.service('Torrents', function() {
    return [];
});

app.controller('LoadController', function($scope, Torrents) {
    $scope.torrents = [];
    $scope.loadFile = function(file) {
	chrome.fileSystem.chooseEntry({
	    type: 'openFile',
	    accepts: [{
		description: "BitTorrent metainfo file",
		mimeTypes: ["application/x-bittorrent"],
		extensions: ["torrent"]
	    }]
	}, function(entry) {
	    entry.file(function(file) {
		var reader = new FileReader();
		reader.onload = function() {
		    // TODO: handle load & parse errors?
		    var torrentMeta = BEnc.parse(reader.result);
		    console.log("meta", torrentMeta);
		    /* Calc infoHash */
		    var sha1 = new Digest.SHA1();
		    var infoParts = BEnc.encodeParts(torrentMeta.info);
		    infoParts.forEach(sha1.update.bind(sha1));
		    torrentMeta.infoHash = new Uint8Array(sha1.finalize());

		    var torrent = new Torrent(torrentMeta);
		    // TODO: infoHash collision?
		    Torrents.push(torrent);
		};
		reader.readAsArrayBuffer(file);
	    });
	});
    };
});

app.controller('TorrentsController', function($scope, Torrents) {
    $scope.torrents = Torrents;
    setInterval(function() {
	$scope.$apply(function() { });
    }, 100);
});
