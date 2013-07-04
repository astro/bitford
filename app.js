"use strict";

var app = angular.module('Bitford', []);

app.controller('LoadController', function($scope) {
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
		chrome.runtime.getBackgroundPage(function(background) {
		    background.loadTorrent(file);
		});
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
		element.attr('width', 3 * Math.ceil(pieceLength / 32768));
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

app.controller('TorrentsController', function($scope) {
    chrome.runtime.getBackgroundPage(function(background) {
	$scope.torrents = background.torrents;
    });
    setInterval(function() {
	$scope.$apply(function() {
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

    $scope.canPlay = function(path) {
	var mimeType = getMimeType(path);
	// TODO: determine support
	return /^video\//.test(mimeType) || /^audio\//.test(mimeType);
    };
    $scope.playButton = function(path) {
	if ($scope.videoURL || $scope.audioURL) {
	    $scope.videoURL = null;
	    $scope.audioURL = null;
	    return;
	}

	var mimeType = getMimeType(path);
	var url = "http://localhost:8080/" + path.join("/");
	if (/^video\//.test(mimeType))
	    $scope.videoURL = url;
	else if (/^audio\//.test(mimeType))
	    $scope.audioURL = url;
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
    if (size < 10) {
        return Math.round(size * 100) / 100 + " " + units[0];
    } else if (size < 100) {
        return Math.round(size * 10) / 10 + " " + units[0];
    } else {
        return Math.round(size) + " " + units[0];
    }
}
