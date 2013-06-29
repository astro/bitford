"use strict";

var app = angular.module('Bitford', []);

app.service('Torrents', function() {
    return [];
});

app.controller('LoadController', function($scope, Torrents) {
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
		    console.log("Torrents", Torrents);
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
		element.attr('width', 3 * Math.ceil(pieceLength / CHUNK_LENGTH));
		element.attr('height', Math.min(3 * pieces.length, 1024));
		var canvas = element[0];
		var ctx = canvas.getContext('2d');
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		for(var y = 0; y < pieces.length; y++) {
		    var y1 = canvas.height * y / pieces.length;
		    var y2 = canvas.height * (y + 1) / pieces.length;
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
    setInterval(function() {
	$scope.$apply(function() {
	    $scope.torrents = Torrents;
	});
    }, 100);
});

var MediaSource_ = window.MediaSource ||
    window.WebKitMediaSource;

app.controller('TorrentController', function($scope) {
    $scope.round = Math.round;
    $scope.humanSize = humanSize;
    $scope.show = false;
    $scope.toggleShow = function() {
	$scope.show = !$scope.show;
    };

    function tick() {
	setTimeout(function() {
	    $scope.$apply(function() {
		$scope.isMultiFile = $scope.torrent.files.length > 1;
	    });
	    tick();
	}, 100);
    }
    tick();

    $scope.playButton = function(path) {
	var size = $scope.torrent.files.filter(function(file) {
	    return file.path == path;
	}).map(function(file) {
	    return file.size;
	})[0];

	var src = new MediaSource_();
	$scope.playingURL = window.URL.createObjectURL(src);
	src.addEventListener('webkitsourceopen', function(ev) {
	    var buf = src.addSourceBuffer("*/*");

	    var bytes = 0;
	    function loop() {
		if (bytes >= size) {
		    src.endOfStream();
		    return;
		}

		$scope.torrent.store.consumeFile(path, bytes, function(data) {
		    if (data.byteLength > 0) {
			try {
			    buf.append(data);
			    bytes += data.byteLength;
			} catch (e) {
			    console.error("SourceBuffer append", e);
			    // HACK: brute-force
			    bytes++;
			}
			loop();
		    } else
			src.endOfStream();
		});
	    }
	    loop();
	});
    };
    $scope.saveButton = function(path) {
	var size = $scope.torrent.files.filter(function(file) {
	    return file.path == path;
	}).map(function(file) {
	    return file.size;
	})[0];

	chrome.fileSystem.chooseEntry({
	    type: 'saveFile',
	    suggestedName: path[path.length - 1]
	}, function(entry) {
	    if (!entry)
		return;

	    entry.createWriter(function(writer) {
		writer.truncate(0);

		$scope.$apply(function() {
		    $scope.saving = true;
		});
		var bytes = 0;
		function loop() {
		    if (bytes >= size) {
			$scope.$apply(function() {
			    $scope.saving = false;
			});
			return;
		    }

		    $scope.torrent.store.consumeFile(path, bytes, function(data) {
			if (data.byteLength > 0) {
			    writer.onwriteend = function() {
				bytes += data.byteLength;
				console.log("written",bytes,"bytes for", entry, writer);
				loop();
			    };
			    writer.onerror = function(error) {
				console.error("write", error);
			    };
			    writer.write(new Blob([data]));
			} else
			    $scope.$apply(function() {
				$scope.saving = false;
			    });
		    });
		}
		loop();
	    }, function(e) {
		console.error("createWriter", e);
	    });
	});
    };
});

function humanSize(size) {
    var units = ["B", "KB", "MB", "GB", "TB"];
    while(size >= 1024 && units.length > 1) {
        size /= 1024;
        units.shift();
    }
    if (size < 1000) {
        return Math.round(size * 1000) / 1000 + " " + units[0];
    } else {
        return Math.round(size) + " " + units[0];
    }
}
