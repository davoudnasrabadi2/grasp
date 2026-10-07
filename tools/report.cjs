#!/usr/bin/env node
/*
 * Grasp — weekly report CLI.
 * Prints the tech-lead weekly report and current state from the demo dataset,
 * using the exact same engine the dashboard runs in the browser.
 *
 *   node tools/report.cjs                 # report for "now"
 *   node tools/report.cjs --at=2026-06-30 # replay: report as of a past date
 */
'use strict';
var fs = require('fs');
var path = require('path');
var signals = require('../assets/js/signals.js');
var printReport = require('../src/report.cjs').printReport;

var dataPath = path.join(__dirname, '..', 'assets', 'data', 'demo-data.js');
var src = fs.readFileSync(dataPath, 'utf8');
var data = JSON.parse(src.slice(src.indexOf('=') + 1, src.lastIndexOf(';')));

var atArg = (process.argv.find(function (a) { return a.indexOf('--at=') === 0; }) || '').slice(5);
var st = signals.computeState(data, atArg ? { at: atArg } : {});

printReport(data, st, { replayed: !!atArg });
