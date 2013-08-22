function RateEstimator() {
    this.bytes = 0;
    this.lastTick = Date.now();
    this.rate = 0;
}

RateEstimator.prototype = {
    interval: 1000,

    canTick: function() {
	var now = Date.now();
	if (now >= this.lastTick + this.interval) {
	    this.rate = 1000 * this.bytes / (now - this.lastTick);
	    this.bytes = 0;
	    this.lastTick = now;
	}
    },

    add: function(amount) {
	this.canTick();
	this.bytes += amount;
    },

    getRate: function() {
	this.canTick();
	return this.rate;
    }
};
