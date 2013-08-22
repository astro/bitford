# Bitford

A BitTorrent client as a Chrome Packaged App.

Contrary to other implementations, this one talks the native
BitTorrent protocol 100% in JavaScript.

## Try it

* Go to `chrome://extensions/`
* ☑ Developer mode
* Load unpacked extension...
* Choose this directory
* Launch

## Roadmap

* Chunks: keep list of requested peers to cancel all only upon reception
* Transition to seeder
* Priorities & unchoke buckets
* Server ports bind retrying
* Tracker events
* Session restore + clean-up unused files

## Unsolved

* Intercept .torrent files that users download

## Torrent Features

* Peer limits
  * Connect rate
  * by IP
  * Upload slots
* Throttling
* UDP trackers
* Extension protocol
* Magnet Links
* DHT
* Encryption
* uTP
