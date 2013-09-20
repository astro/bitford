"use strict";

var app = angular.module('Bitford', []);

app.controller('MainController', function($scope) {
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

    chrome.runtime.getBackgroundPage(function(background) {
	$scope.upShaper = Math.ceil(background.upShaperRate.rate / 1024);
	$scope.downShaper = Math.ceil(background.downShaperRate.rate / 1024);
    });
    $scope.changeShapers = function() {
	chrome.runtime.getBackgroundPage(function(background) {
	    background.upShaperRate.rate = parseInt($scope.upShaper, 10) * 1024;
	    background.downShaperRate.rate = parseInt($scope.downShaper, 10) * 1024;
	});
    };
});

app.directive('piecesCanvas', function() {
    return {
	restrict: 'A',
	link: function($scope, element, attrs) {
	    function draw() {
		if (attrs['piecesCanvas'] && !$scope.$eval(attrs['piecesCanvas'])) {
		    setTimeout(draw, 300);
		    return;
		}

		var t1 = Date.now();

		var pieces = $scope.torrent.store.pieces;
		if (!pieces)
		    return;
		var pieceLength = $scope.torrent.store.pieceLength;
		element.attr('width', Math.min(2048, 4 * pieces.length));
		element.attr('height', Math.min(64, 4 * Math.ceil(pieceLength / 32768)));
		var canvas = element[0];
		var ctx = canvas.getContext('2d');
		ctx.fillStyle = "white";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		for(var x = 0; x < pieces.length; x++) {
		    var x1 = Math.floor(canvas.width * x / pieces.length);
		    var x2 = Math.floor(canvas.width * (x + 1) / pieces.length);
		    if (pieces[x].valid) {
			ctx.fillStyle = "#3f3";
			ctx.fillRect(x1, 0, x2, canvas.height);
		    } else if (!pieces[x].chunks.some(function(chunk) {
							  return chunk.state !== 'missing';
						      })) {
			ctx.fillStyle = "#ccc";
			ctx.fillRect(x1, 0, x2, canvas.height);
		    } else
			pieces[x].chunks.forEach(function(chunk) {
			    var y1 = canvas.height * chunk.offset / pieceLength;
			    var y2 = canvas.height * (chunk.offset + chunk.length) / pieceLength;
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

		var t2 = Date.now();
		/* Allow max. 10% CPU time */
		setTimeout(draw, Math.ceil(Math.max(50, t2 - t1) / .10));
	    }
	    draw();
        }
    };
});

app.controller('TorrentsController', function($scope, $rootScope) {
    $scope.selected = undefined;
    $scope.selectTorrent = function(torrent) {
	console.log("selected", torrent);
	$scope.selected = torrent;
    };
    var updateFromBackground = function(background) {
	$scope.torrents = background.torrents;
	$rootScope.peerPort = background.peerPort;
    };
    chrome.runtime.getBackgroundPage(updateFromBackground);
    setInterval(function() {
	$scope.$apply(function() {
	    chrome.runtime.getBackgroundPage(updateFromBackground);
	});
    }, 500);
});

var MediaSource_ = window.MediaSource ||
    window.WebKitMediaSource;

app.controller('TorrentController', function($scope) {
    $scope.tab = 'files';
    $scope.round = Math.round;
    $scope.humanSize = humanSize;
    $scope.estimateTime = function(torrent) {
	var seconds = torrent.store.getBytesLeft() / torrent.downRate.getRate();
	if (seconds < 7 * 24 * 60 * 60)
	    return formatSeconds(seconds);
	else
	    return "∞";
    };
    $scope.ratio = function(torrent) {
	if (torrent.bytesDownloaded >= 1) {
	    var r = torrent.bytesUploaded / torrent.bytesDownloaded;
	    return Math.floor(r) + "." + pad(Math.floor(100 * r), 2, "0");
	} else
	    return "∞";
    };
    $scope.peerIdToClient = peerIdToClient;
    $scope.formatInterval = function(time) {
	if (typeof time === 'number') {
	    return formatSeconds((time - Date.now()) / 1000);
	} else if (time === 'now') {
	    return "now";
	} else {
	    return "";
	}
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

	chrome.runtime.getBackgroundPage(function(background) {
	    var httpStreamPort = background.httpStreamPort;
	    var mimeType = getMimeType(path);
	    console.log("app httpStreamPort", httpStreamPort);
	    var url = "http://localhost:" + httpStreamPort + "/" + path.join("/");
	    if (/^video\//.test(mimeType))
		$scope.videoURL = url;
	    else if (/^audio\//.test(mimeType))
		$scope.audioURL = url;
	    $scope.$digest();
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
    $scope.removeButton = function() {
	chrome.runtime.getBackgroundPage(function(background) {
	    background.rmTorrent($scope.torrent);
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

var MINUTE = 60;
var HOUR = 60 * MINUTE;
var DAY = 24 * HOUR;
var MONTH = 30 * DAY;
var YEAR = 365 * DAY;
function formatSeconds(secs) {
    if (secs < 1)
	return "now";

    var frags = [];
    function addFrag(n, s) {
	if (n !== 0 || frags.length > 0)
	    frags.push(n + " " + s + (n === 1 ? "" : "s"));
    }
    addFrag(Math.floor(secs / YEAR), "year");
    secs %= YEAR;
    addFrag(Math.floor(secs / MONTH), "month");
    secs %= MONTH;
    addFrag(Math.floor(secs / DAY), "day");
    secs %= DAY;
    addFrag(Math.floor(secs / HOUR), "hour");
    secs %= HOUR;
    addFrag(Math.floor(secs / MINUTE), "minute");
    secs %= MINUTE;
    addFrag(Math.floor(secs), "second");

    return frags.slice(0, 2).join(", ");
}


var PEER_ID_CLIENTS = {
    'AB': "AnyEvent::BitTorrent",
    'AG': "Ares",
    'A~': "Ares",
    'AR': "Arctic",
    'AV': "Avicora",
    'AT': "Artemis",
    'AX': "BitPump",
    'AZ': "Azureus",
    'BB': "BitBuddy",
    'BC': "BitComet",
    'BF': "Bitflu",
    'BG': "BTG (uses Rasterbar libtorrent)",
    'BL': "BitBlinder",
    'BP': "BitTorrent Pro (Azureus + spyware)",
    'BR': "BitRocket",
    'BS': "BTSlave",
    'BT': "BBtor",
    'BW': "BitWombat",
    'BX': "~Bittorrent X",
    'CD': "Enhanced CTorrent",
    'CT': "CTorrent",
    'DE': "DelugeTorrent",
    'DP': "Propagate Data Client",
    'EB': "EBit",
    'ES': "electric sheep",
    'FC': "FileCroc",
    'FT': "FoxTorrent",
    'FX': "Freebox BitTorrent",
    'GS': "GSTorrent",
    'HK': "Hekate",
    'HL': "Halite",
    'HM': "hMule (uses Rasterbar libtorrent)",
    'HN': "Hydranode",
    'JS': "Justseed.it client",
    'JT': "JavaTorrent",
    'KG': "KGet",
    'KT': "KTorrent",
    'LC': "LeechCraft",
    'LH': "LH-ABC",
    'LP': "Lphant",
    'LT': "libtorrent",
    'lt': "libTorrent",
    'LW': "LimeWire",
    'MK': "Meerkat",
    'MO': "MonoTorrent",
    'MP': "MooPolice",
    'MR': "Miro",
    'MT': "MoonlightTorrent",
    'NB': "Net::BitTorrent",
    'NX': "Net Transport",
    'OS': "OneSwarm",
    'OT': "OmegaTorrent",
    'PB': "Protocol::BitTorrent",
    'PD': "Pando",
    'PT': "PHPTracker",
    'qB': "qBittorrent",
    'QD': "QQDownload",
    'QT': "Qt 4 Torrent example",
    'RT': "Retriever",
    'RZ': "RezTorrent",
    'S~': "Shareaza alpha/beta",
    'SB': "~Swiftbit",
    'SD': "Thunder (aka XùnLéi)",
    'SM': "SoMud",
    'SS': "SwarmScope",
    'ST': "SymTorrent",
    'st': "sharktorrent",
    'SZ': "Shareaza",
    'TE': "terasaur Seed Bank",
    'TL': "Tribler (versions >= 6.1.0)",
    'TN': "TorrentDotNET",
    'TR': "Transmission",
    'TS': "Torrentstorm",
    'TT': "TuoTu",
    'UL': "uLeecher!",
    'UM': "µTorrent for Mac",
    'UT': "µTorrent",
    'VG': "Vagaa",
    'WT': "BitLet",
    'WY': "FireTorrent",
    'XL': "Xunlei",
    'XS': "XSwifter",
    'XT': "XanTorrent",
    'XX': "Xtorrent",
    'ZT': "ZipTorrent"
};

/* https://wiki.theory.org/BitTorrentSpecification#peer_id */
function peerIdToClient(peerId) {
    if (!peerId)
	return "";

    peerId = UTF8ArrToStr(peerId);

    var m;
    if ((m = peerId.match(/^M(\d+)-(\d+)-(\d+)-/))) {
	return "Mainline/" + m[1] + "." + m[2] + "." + m[3];
    } else if ((m = peerId.match(/^-(..)(.)(.)(.)(.)-/))) {
	var version = [m[2], m[3], m[4], m[5]].map(function(v) {
	    var v1 = v.charCodeAt(0);
	    if (v1 >= 65 && v1 <= 90)
		return v1 - 55;
	    else if (v1 >= 87 && v1 <= 122)
		return v1 - 77;
	    else
		return v;
	});
	while(version.length > 1 && (version[version.length - 1] + "") === "0")
	    version.pop();

	var client = PEER_ID_CLIENTS[m[1]];
	if (client)
	    return client + "/" + version.join(".");
	else
	    return m[1] + "/" + version.join(".");
    } else {
	/* TODO: Shad0w style */
	return peerId.slice(0, 8);
    }
}

function pad(s, len, padding) {
    s = "" + s;
    while(s.length < len)
	s = padding + s;
    return s;
}
