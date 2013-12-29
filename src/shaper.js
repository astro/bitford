function RateShaper(rate) {
    this.rate = rate;
    this.nextTick = Date.now();
    this.next = null;
    this.last = null;
}

RateShaper.prototype = {
    enqueue: function(item) {
        if (!this.next) {
            this.next = item;
            this.last = item;
        } else {
            this.last.next = item;
            this.last = item;
        }
        this.tick();
    },

    tick: function() {
        if (this.timeout || !this.next)
            return;

        var now = Date.now();
        if (now < this.nextTick) {
            this.timeout = setTimeout(function() {
                this.timeout = null;
                this.tick();
            }.bind(this), Math.ceil(this.nextTick - now));
        } else {
            var item = this.next;
            this.next = item.next;
            if (!this.next)
                this.last = null;

            if (this.rate > 0) {
                var penalty = now - this.nextTick;
                this.nextTick = now + Math.max(0, 1000 * item.amount / this.rate - penalty);
            } else
                this.nextTick = now + 1;

            try {
                item.cb();
            } catch (e) {
                console.error("shaper", e.stack);
            }

            this.tick();
        }
    }
};

/* Shaper setup */
var upShaperRate = new RateShaper(102400);
var upShaper = {
    enqueue: upShaperRate.enqueue.bind(upShaperRate)
};

var downShaperRate = new RateShaper(0);
var downShaper = {
    enqueue: downShaperRate.enqueue.bind(downShaperRate)
};
