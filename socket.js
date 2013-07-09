var Socket = chrome.socket || chrome.experimental.socket;

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
	var sockId = createInfo.socketId;
	var sock = new TCPSocket(sockId);
	sock.connect(host, port, function(err) {
	    cb(err, err ? null : sock);
	});
    });
}

/* TODO: use an event emitter */
function TCPSocket(sockId) {
    this.sockId = sockId;
    this.writesPending = 0;
    this.paused = true;
    this.readPending = false;
    this.drained = true;
}

TCPSocket.prototype = {
    connect: function(host, port, cb) {
	chrome.socket.connect(this.sockId, host, port, function(res) {
	    if (res === 0)
		cb(null);
	    else
		cb(new Error("Connect: " + res));
	});
    },

    getInfo: function(cb) {
	chrome.socket.getInfo(this.sockId, cb);
    },

    pause: function() {
	this.paused = true;
    },

    resume: function() {
	this.paused = false;
	this.read();
    },

    read: function() {
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
    },

    write: function(data) {
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
    },

    end: function() {
	if (!this.sockId)
	    return;

	if (this.onEnd)
	    this.onEnd();
	Socket.disconnect(this.sockId);
	Socket.destroy(this.sockId);

	delete this.sockId;
    }
};
