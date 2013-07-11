var Socket = chrome.socket || chrome.experimental.socket;

function BaseSocket(sockId) {
    this.sockId = sockId;
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
    }
};

/* Creates paused sockets */
function createTCPServer(host, port, cb) {
    if (!cb) {
	// Shift args
	cb = port;
	port = host;
	host = "::";
    }
    var backlog = 1;

    Socket.create('tcp', {}, function(createInfo) {
	var sockId = createInfo.socketId;
	Socket.listen(sockId, host, port, backlog, function(res) {
	    function loop() {
		Socket.accept(sockId, function(acceptInfo) {
		    var sockId = acceptInfo.socketId;
		    if (sockId) {
			var sock = new TCPSocket(sockId);
			cb(sock);
		    }
		    loop();
		});
	    }
	    if (res >= 0)
		loop();
	    else
		console.error("Cannot listen on", host, ":", port, ":", res);
	});
    });
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
    this.paused = true;
    this.readPending = false;
    this.drained = true;
}

TCPSocket.prototype = Object.create(BaseSocket.prototype);
TCPSocket.prototype.constructor = TCPSocket;

TCPSocket.prototype.connect = function(host, port, cb) {
	chrome.socket.connect(this.sockId, host, port, function(res) {
	    if (res === 0)
		cb(null);
	    else
		cb(new Error("Connect: " + res));
	});
};

TCPSocket.prototype.pause = function() {
	this.paused = true;
};

TCPSocket.prototype.resume = function() {
	this.paused = false;
	this.read();
};

TCPSocket.prototype.read = function() {
	if (this.paused || this.readPending)
	    return;
	this.readPending = true;
	Socket.read(this.sockId, function(readInfo) {
	    this.readPending = false;
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
};

TCPSocket.prototype.write = function(data) {
	if (!this.sockId)
	    return;

	if (typeof data === 'string')
	    data = strToUTF8Arr(data);
	else if (data.buffer)
		data = data.buffer;

	Socket.write(this.sockId, data, function(writeInfo) {
	    if (writeInfo.bytesWritten < 0) {
		console.error("Write to socket", this.sockId, ":", writeInfo.bytesWritten);
		return this.end();
	    }
	    this.writesPending--;

	    if (this.writesPending < 1) {
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


/**
 * Isn't immediately ready, use cb().
 */
function UDPSocket(cb) {
    Socket.create('udp', {}, function(createInfo) {
		      console.log("udp", createInfo);
	BaseSocket.call(this, createInfo.socketId);
	if (cb)
	    try {
		cb(this);
	    } catch (e) {
		console.error(e.stack || e.message || e);
	    }

	this.recvLoop();
    }.bind(this));
}

UDPSocket.prototype = Object.create(BaseSocket.prototype);
UDPSocket.prototype.constructor = UDPSocket;

UDPSocket.prototype.sendTo = function(data, address, port) {
    chrome.socket.sendTo(this.sockId, data, address, port, function(writeInfo) {
    });
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
