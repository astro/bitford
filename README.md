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
* Keep an eye on the console of the background page

## Roadmap

* Show ETA
* Server ports bind retrying
* Transition to seeder
* Tracker events
* Priorities & unchoke buckets
* Session restore + clean-up unused files

## Unsolved

* Intercept .torrent files that users download
  * https://github.com/Rob--W/pdf.js/commit/e181a3c902485a5c3e155c555abb6d686604457b

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
