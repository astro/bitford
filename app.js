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

app.directive('piecesCanvas', function() {
    return {
	restrict: 'A',
	link: function($scope, element, attrs) {
	    function draw() {
		var pieces = $scope.torrent.store.pieces;
		if (!pieces)
		    return;
		var pieceLength = $scope.torrent.store.pieceLength;
		var maxP = Math.min(pieces.length, 200);
		element.attr('width', 3 * Math.ceil(pieceLength / CHUNK_LENGTH));
		element.attr('height', Math.min(3 * maxP, 1024));
		var canvas = element[0];
		var ctx = canvas.getContext('2d');
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		for(var y = 0; y < maxP; y++) {
		    var y1 = canvas.height * y / maxP;
		    var y2 = canvas.height * (y + 1) / maxP;
		    if (pieces[y].valid) {
			ctx.fillStyle = "#3f3";
			ctx.fillRect(0, y1, canvas.width, y2);
		    } else
			pieces[y].chunks.forEach(function(chunk) {
			    var x1 = canvas.width * chunk.offset / pieceLength;
			    var x2 = canvas.width * (chunk.offset + chunk.length) / pieceLength;
			    switch(chunk.state) {
				case 'missing':
				    ctx.fillStyle = "#ccc";
				    break;
				case 'requested':
				    ctx.fillStyle = "red";
				    break;
				case 'received':
				    ctx.fillStyle = "yellow";
				    break;
				case 'written':
				    ctx.fillStyle = "blue";
				    break;
				case 'valid':
				    ctx.fillStyle = "#0c0";
				    break;
				default:
				    ctx.fillStyle = "black";
			    }
			    ctx.fillRect(x1, y1, x2, y2);
			});
		}

		setTimeout(draw, 1000);
	    }
	    draw();
        }
    };
});

app.controller('TorrentsController', function($scope, Torrents) {
    $scope.torrents = Torrents;
    $scope.round = Math.round;
    function tick() {
	setTimeout(function() {
	    $scope.$apply(function() { });
	    tick();
	}, 100);
    }
    tick();
});
