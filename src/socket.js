var Socket = chrome.socket || chrome.experimental.socket;

function BaseSocket(sockId) {
    this.sockId = sockId;

    this.paused = true;
    this.readPending = false;
}

BaseSocket.prototype = {
    getInfo: function(cb) {
	chrome.socket.getInfo(this.sockId, cb);
    },

    end: function() {
	if (!this.sockId)
	    return;

	if (this.onEnd)
	    this.onEnd();
	Socket.destroy(this.sockId);

	delete this.sockId;
    },

    pause: function() {
	this.paused = true;
    },

    resume: function() {
	this.paused = false;
	this.read();
    },

    connect: function(host, port, cb) {
	chrome.socket.connect(this.sockId, host, port, function(res) {
	    if (res === 0)
		cb(null);
	    else
		cb(new Error("Connect: " + res));
	});
    },

    read: function() {
	if (this.paused || this.readPending)
	    return;
	this.readPending = true;
	Socket.read(this.sockId, this.readLength, function(readInfo) {
	    this.readPending = false;
	    this.readLength = undefined;
	    if (readInfo.resultCode < 0)
		return this.end();
	    if (readInfo.data && this.onData) {
		try {
		    this.onData(readInfo.data);
		    /* onData() could have closed it */
		    if (this.sockId)
			this.read();
		} catch (e) {
		    console.error(e.stack || e.message || e);
		    this.end();
		}
	    }
	}.bind(this));
    }
};

/* Creates paused sockets */
function createTCPServer(host, port, acceptCb, listenCb) {
    var backlog = 1;

    Socket.create('tcp', {}, function(createInfo) {
	var sockId = createInfo.socketId;
	Socket.listen(sockId, host, port, backlog, function(res) {
	    function loop() {
		Socket.accept(sockId, function(acceptInfo) {
		    var sockId = acceptInfo.socketId;
		    if (sockId) {
			var sock = new TCPSocket(sockId);
			acceptCb(sock);
		    }
		    loop();
		});
	    }
	    if (res >= 0) {
		if (listenCb)
		    listenCb();
		loop();
	    } else {
		console.error("Cannot listen on", host, ":", port, ":", res);
		if (listenCb)
		    listenCb(new Error("Listen: " + res));
	    }
	});
    });
}

function tryCreateTCPServer(port, acceptCb, listenCb) {
    var attempt = 0;
    function doTry() {
	attempt++;
	createTCPServer("::", port, acceptCb, function(err) {
	    if (err) {
		if (attempt < 100) {
		    port += 1 + Math.floor(7 * Math.random());
		    doTry();
		} else {
		    listenCb(err);
		}
	    } else {
		listenCb(null, port);
	    }
	});
    }
    doTry();
}

/* Creates paused sockets */
function connectTCP(host, port, cb) {
    Socket.create('tcp', {}, function(createInfo) {
	var sock = new TCPSocket(createInfo.socketId);
	sock.connect(host, port, function(err) {
	    cb(err, err ? null : sock);
	});
    });
}

/* TODO: use an event emitter */
function TCPSocket(sockId) {
    BaseSocket.call(this, sockId);

    this.writesPending = 0;
    this.drained = true;
}

TCPSocket.prototype = Object.create(BaseSocket.prototype);
TCPSocket.prototype.constructor = TCPSocket;

TCPSocket.prototype.write = function(data) {
	if (!this.sockId)
	    return;

	if (typeof data === 'string')
	    data = strToUTF8Arr(data);
	if (data.buffer)
	    data = data.buffer;

	Socket.write(this.sockId, data, function(writeInfo) {
	    if (writeInfo.bytesWritten < 0) {
		console.warn("Write to socket", this.sockId, ":", writeInfo.bytesWritten);
		return this.end();
	    }
	    this.writesPending--;

	    if (this.writesPending < 1 && this.sockId) {
		this.drained = true;
		if (this.onDrain)
		    this.onDrain();
	    }
	}.bind(this));
	this.writesPending++;
	this.drained = false;
};

TCPSocket.prototype.end = function() {
	if (this.sockId) {
	    Socket.disconnect(this.sockId);
	    BaseSocket.prototype.end.call(this, arguments);
	}
};


function connectUDP(host, port, cb) {
    Socket.create('udp', {}, function(createInfo) {
	var sock = new UDPSocket(createInfo.socketId);
	sock.connect(host, port, function(err) {
	    try {
		cb(err, err ? null : sock);
	    } catch (e) {
		console.warn(e.stack || e.message || e);
	    }
	});
    });
}

function UDPSocket(sockId) {
    BaseSocket.call(this, sockId);
}

UDPSocket.prototype = Object.create(BaseSocket.prototype);
UDPSocket.prototype.constructor = UDPSocket;

UDPSocket.prototype.write = function(data) {
	if (!this.sockId)
	    return;

	if (typeof data === 'string')
	    data = strToUTF8Arr(data);
	else if (data.buffer)
		data = data.buffer;

	Socket.write(this.sockId, data, function(writeInfo) {
	    if (writeInfo.bytesWritten < 0) {
		console.warn("Write to socket", this.sockId, ":", writeInfo.bytesWritten);
		return this.end();
	    }
	}.bind(this));
};

UDPSocket.prototype.recvLoop = function() {
    chrome.socket.recvFrom(this.sockId, function(recvFromInfo) {
	if (recvFromInfo.resultCode > 0 && this.onData) {
	    try {
		this.onData(recvFromInfo.data, recvFromInfo.address, recvFromInfo.port);
	    } catch (e) {
		console.error(e.stack || e.message || e);
	    }
	    this.recvLoop();
	} else {
	    console.warn("UDPSocket", this.sockId, "recvFrom", recvFromInfo);
	}
    }.bind(this));
};
