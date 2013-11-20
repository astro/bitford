function RateEstimator() {
    this.bytes = 0;
    this.lastTick = Date.now();
    this.rates = [];
    this.rate = 0;
    this.bestRate = 0;
}

RateEstimator.prototype = {
    interval: 1000,
    window: 10,

    canTick: function() {
	var now = Date.now();
	if (now >= this.lastTick + this.interval) {
	    /* Accumulate */
	    this.rates.push(1000 * this.bytes / (now - this.lastTick));
	    while(this.rates.length > this.window)
		this.rates.shift();
	    /* Calculate average */
	    this.rate = 0;
	    for(var i = 0; i < this.rates.length; i++)
		this.rate += this.rates[i];
	    if (this.rates.length > 0)
		this.rate /= this.rates.length;
	    /* Reset */
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
        if (this.rate > this.bestRate)
            this.bestRate = this.rate;
	return this.rate;
    }
};
