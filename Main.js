const CDP = require('chrome-remote-interface');
const chromeLauncher = require('chrome-launcher');
const delay = require('delay');
var cluster = require('cluster');
var nthline = require('nthline');
var winston = require('winston');
var winstonCluster = require('winston-cluster');
var logLevel = 'info';

// Mongoose models
var DB = require('./DB');
var Script = require('./Script').model;
var Request = require('./Request').model;
var ScrappedContent = require('./ScrappedContent');

/**
 * Launches a debugging instance of Chrome.
 * 
 * @param {boolean=} headless True (default) launches Chrome in headless mode.
 * False launches a full version of Chrome.
 * @return {Promise<ChromeLauncher>}
 */
async function launchChrome(headless=true) {
  return chromeLauncher.launch({
    chromeFlags: [
      '--disable-gpu',
      headless ? '--headless' : ''
    ]
  });
}

/**
 * Process the scrapped materials from the URL.
 * For debugging purposes, not to be used with
 * large scale runs, unless you want to clutter
 * your terminal.
 * 
 * @param {ScrappedContent} content 
  */
function processUrlContents(content) {
    for (let s of content.scripts) {
        s.dumpToConsole();
    }
    for (let r of content.requests) {
        r.dumpToConsole();
    }
    console.log(finalHtml);
}

/**
 * Initializes the chrome instance in headless mode,
 * also initializes the chrome devtools protocol client.
 * 
 * @returns the chrome and the protocol client instance.
 */
async function init() {
    // Wait for chrome to launch
    var chrome = await launchChrome(true);
    
    // Connect to endpoint
    var client = await CDP({port: chrome.port});

    return {chrome: chrome, client: client};
}

/**
 * Main function that launches an instance of chrome
 * and retrieves the information from it through the
 * devtools protocol.
 *
 * @param {any} logger
 * @param {any} startLine 
 * @param {any} endLine 
 * 
 * @returns {int} the exitcode, 0 for no error, 1 otherwise.
 */
async function runScrapper(logger, startLine, endLine) {
    var chrome = null;
    var client = null;

    try {
        var agents = await init();
        // Expand into the required agents.
        var chrome = agents.chrome;
        var client = agents.client;
    } catch (error) {
        logger.log('warn', 'Error initializing chrome and CDP client : ' +  String(error));
        return 1;
    }
    
    try {
        // Extract required domains
        const {Network, Page, Debugger, Runtime} = client;

        // Get the Alexa dataset filepath from the properties.
        var filePath = require('./property').urlDataset;

        // Container for storing the script objects.
        var scripts = [];
        
        // Container for request objects.
        var requests = [];

        // Variable for start time reference point.
        var hrstart = process.hrtime();;

        // Setup handlers for: 
        // request about to be sent.
        Network.requestWillBeSent((params) => {
            let hrend = process.hrtime(hrstart);
            let elapsed = hrend[0] * 1000 + hrend[1]/1000000;

            var request = new Request();
            request.url = params.request.url;
            request.timeFromPageLoad = elapsed;
            requests.push(request);
        });

        // Scripts parsed.
        Debugger.scriptParsed(async (params) => {
            try {
                // Fetch the source of the script from the debugger.
                // Retrieve the script source as a promise.
                let source = await Debugger.getScriptSource({scriptId: params.scriptId});
                var script = new Script();
                script.source = source.scriptSource;
                script.scriptId = params.scriptId;
                script.url = params.url;
                script.startLine = params.startLine;
                script.startColumn = params.startColumn;
                script.endLine = params.endLine;
                script.endColumn = params.endColumn;
                script.hash = params.hash;
                script.failedToParse = false;
                scripts.push(script);
            } catch (error) {
                // Don't care, if the debugger is unable to give the source, the script is no longer available.    
            }
        });

        // Scripts failed to parse.
        Debugger.scriptFailedToParse(async (params) => {
            try {
                // Fetch the source of the script from the debugger.
                // Retrieve the script source as a promise.
                let source = await Debugger.getScriptSource({scriptId: params.scriptId});
                var script = new Script();
                script.source = source.scriptSource;
                script.scriptId = params.scriptId;
                script.url = params.url;
                script.startLine = params.startLine;
                script.startColumn = params.startColumn;
                script.endLine = params.endLine;
                script.endColumn = params.endColumn;
                script.hash = params.hash;
                script.failedToParse = true;
                scripts.push(script);
            } catch (error) {
                // Don't care, if the debugger is unable to give the source, the script is no longer available.    
            }
        });

        // Enable events, then start.
        await Promise.all([Network.enable(), Page.enable(), Debugger.enable()]);
        await Network.setCacheDisabled({cacheDisabled: true});

        // Start loading the pages one by one.
        for (var i = startLine; i <= endLine; i++) {
            var line = await nthline(i, filePath);
            var vals = line.split(",");
            var rank = parseInt(vals[0]);
            var url = vals[1];

            // Clear out the script and the request container.
            scripts = [];
            requests = [];
            
            // The scrapped content model object.
            let content = new ScrappedContent();
            content.url = url;
            content.rank = rank;

            hrstart = process.hrtime();

            // Timing start point and navigate to the url.
            try {
                await Page.navigate({url: 'http://' + url});
                await Page.loadEventFired();
                logger.log('info', 'Processing rank: ' + rank + ', ' + url);
    
                // Get the final html.
                var finalPageContent = await Runtime.evaluate({
                    expression: 'document.documentElement.outerHTML'
                });
    
                /* 
                * Wait for 5000 ms before returning so that we can finish latching
                * onto any delayed request and consequent script content.
                * See https://github.com/shaowns/chromejsscrapper/issues/1
                */
                await delay(5000);
            } catch(error) {
                logger.log('error', "Error processing web page: " + rank + ", " + url + ", " + String(error));
            }            

            // Save the scripts, requests, and the final html into the content object.
            content.scripts = scripts;
            content.requests = requests;
            content.finalHtml = finalPageContent.result.value;

            // Save the content in the DB.
            await content.save(function(error) {
                if (error) {
                    logger.log('error', "Error saving contents, rank " + rank + ", url: " + url + ". " + String(error));
                }
            });
        }
    } catch (error) {
        logger.log('error', "Error loading pages and extracting " + String(error));
    } finally {
        if (client) {
            await client.close();
        }
        if (chrome) {
            await chrome.kill();
        }
    }
    return 0;
}

function main() {
    if(cluster.isMaster) {
        var numWorkers = require('os').cpus().length;
        if (numWorkers > 8) {
            numWorkers = 8;
        }
        var logger = new (winston.Logger)({
            transports: [
              new (winston.transports.Console)({
                level: logLevel,
              })
            ]
          });

        logger.log('info', 'Master cluster setting up ' + numWorkers + ' workers...');

        // Setup the file access parameters.
        const lineLimit = require('./property').urlLimit;
        const lineStart = require('./property').urlStart;
        const sliceSize = Math.floor(lineLimit/numWorkers);

        // Spin up the workers.
        for(var i = 0; i < numWorkers; i++) {
            var worker = cluster.fork();
            
            var sliceStart = lineStart + i * sliceSize;
            var sliceEnd = (i == numWorkers - 1) ? lineLimit - 1 : sliceStart + sliceSize - 1;

            worker.send({
                type: 'scrape',
                startLine: sliceStart,
                endLine: sliceEnd
            });

            worker.on('message', function(message) {
                if (message.type == 'fail') {
                    logger.log('warn', 'Worker ' + worker.id + ' failed, forking a new worker with the same task');
                    var newWorker = cluster.fork();
                    newWorker.send({
                        type: 'scrape',
                        startLine: message.startLine,
                        endLine: message.endLine
                    });
                }
            });
        }

        // Bind event listeners to child threads using the local logger instance
        winstonCluster.bindListeners(logger);

        cluster.on('online', function(worker) {
            logger.log('info', 'Worker ' + worker.id + ' is online');
        });

        cluster.on('exit', function(worker, code, signal) {
            logger.log('info', 'Worker ' + worker.id + ' died with code: ' + code + ', and signal: ' + signal);
            logger.log('info', 'Workers alive: ' + Object.keys(cluster.workers).length);

            // Check if there are no more workers, then gracefully exit the master to close mongoose connections.
            if (Object.keys(cluster.workers).length == 0) {                
                process.exit(0);
            }
        });
    } else if (cluster.isWorker){
        process.on('message', async function(message) {
            if (message.type == 'scrape') {
                var logger = new (winston.Logger)({
                    transports: [
                      new (winston.transports.Cluster)({
                        level: logLevel,
                      })
                    ]
                  });

                var exitCode = await runScrapper(logger, message.startLine, message.endLine);
                // If there was an exit code then we would have to close this one and create a
                // new worker with the same task as this one.
                if (exitCode) {
                    process.send({
                        type: 'fail',
                        startLine: message.startLine,
                        endLine: message.endLine
                    });
                }
                logger.log('info', 'Worker finished.');
                process.exit(exitCode);
            }            
        });
    }
}

// Call the main function.
main();