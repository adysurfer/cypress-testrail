const TestRail = require('./components/TestRail/TestRail');
const TestCaseParser = require('./services/TestCaseParser');
const Result = require('./components/TestRail/Result');
const ConfigService = require('./services/Config/ConfigService');
const TestData = require('./components/Cypress/TestData');
const ColorConsole = require('./services/ColorConsole');
const CypressStatusConverter = require('./services/CypressStatusConverter');
const fs = require('fs');
const packageData = require('../package.json');
const FileWriter = require('./services/FileWriter');

class Reporter {
    /**
     * @param {EventEmitter} on
     * @param {object} config
     * @param {string} [customComment] - Provide a custom comment if you want to add something to the result comment.
     * @param {string} [metadataFilePath]
     */
    constructor(on, config, customComment, metadataFilePath) {
        this.on = on;

        this.testCaseParser = new TestCaseParser();
        this.fileWriter = new FileWriter();

        const configService = new ConfigService(config.env);

        this.enabled = configService.isApiValid();

        this.domain = configService.getDomain();
        this.projectId = configService.getProjectId();
        this.milestoneId = configService.getMilestoneId();
        this.suiteId = configService.getSuiteId();

        const singleRunId = configService.getRunId();
        if (singleRunId !== '') {
            this.runIds = [singleRunId];
        } else {
            this.runIds = configService.getRunIds();
        }

        this.runName = configService.getRunName();
        this.screenshotsEnabled = configService.isScreenshotsEnabled();
        this.includeAllCasesDuringCreation = configService.includeAllCasesDuringCreation();
        this.includeAllFailedScreenshots = configService.includeAllFailedScreenshots();
        this.ignorePendingTests = configService.ignorePendingCypressTests();

        this.modeCreateRun = !configService.hasRunID();
        this.closeRun = configService.shouldCloseRun();
        this.foundCaseIds = [];

        this.statusConverter = new CypressStatusConverter(
            configService.getTestRailStatusPassed(),
            configService.getTestRailStatusFailed(),
            configService.getTestRailStatusSkipped()
        );

        this.customComment = customComment !== undefined && customComment !== null ? customComment : '';
        this.metadataFilePath = metadataFilePath !== undefined && metadataFilePath !== null ? metadataFilePath : '';

        this.testrail = new TestRail(
            configService.getDomain(),
            configService.getUsername(),
            configService.getPassword(),
            configService.isScreenshotsEnabled()
        );
    }

    /**
     * Registers event listeners for TestRail integration.
     */
    register() {
        if (!this.enabled) {
            ColorConsole.info('');
            ColorConsole.info('');
            ColorConsole.warn(`TestRail Integration v${packageData.version}`);
            ColorConsole.warn('....................................................');
            ColorConsole.warn('Integration is not correctly configured.');
            ColorConsole.warn('If you expect this to work, please check your configuration.');
            return;
        }

        this.on('before:run', async (details) => {
            await this._beforeRun(details);
        });

        this.on('after:spec', async (spec, results) => {
            await this._afterSpec(spec, results);
        });

        this.on('after:run', async (afterRunDetails) => {
            await this._afterRun(afterRunDetails);
        });
    }

    /**
     * Pre-run setup.
     * @param {object} details
     * @private
     */
    async _beforeRun(details) {
        this.baseURL = details.config.baseUrl;
        this.cypressVersion = details.cypressVersion;
        this.browser = details.browser !== undefined
            ? `${details.browser.displayName} (${details.browser.version})`
            : 'unknown';
        this.system = `${details.system.osName} (${details.system.osVersion})`;
        this.tags = details.config.env.tags;

        ColorConsole.success(`  Starting TestRail Integration v${packageData.version}`);
        ColorConsole.info('  ....................................................');
        ColorConsole.info(`  TestRail Domain: ${this.domain}`);
        ColorConsole.info(`  Environment/ Base URL: ${this.baseURL}`);
        ColorConsole.info(`  Cypress Version: ${this.cypressVersion}`);
        ColorConsole.info(`  Browser: ${this.browser}`);
        ColorConsole.info(`  OS: ${this.system}`);
        ColorConsole.info(`  Testing Type (Tags): ${this.tags}`);

        if (this.modeCreateRun) {
            ColorConsole.info('TestRail Mode: Create Run');
            ColorConsole.info(`TestRail Project ID: ${this.projectId}`);
            ColorConsole.info(`TestRail Milestone ID: ${this.milestoneId}`);
            ColorConsole.info(`TestRail Suite ID: ${this.suiteId}`);
            ColorConsole.info(`TestRail Run Name: ${this.runName}`);
            ColorConsole.info(`TestRail Include All Cases: ${this.includeAllCasesDuringCreation}`);
        } else {
            ColorConsole.info('TestRail Mode: Use existing Run(s)');
            ColorConsole.info(`TestRail Run ID(s): ${this.runIds.map((id) => 'R' + id)}`);
        }

        ColorConsole.info(`Ignore pending tests: ${this.ignorePendingTests}`);
        ColorConsole.info(`Screenshots: ${this.screenshotsEnabled}`);
        ColorConsole.info(`Include All Failed Screenshots: ${this.includeAllFailedScreenshots}`);

        if (this.modeCreateRun) {
            await this._createTestRailRun();
        }
    }

    /**
     * Handles after spec events.
     * @param {object} spec
     * @param {object} results
     * @private
     */
    async _afterSpec(spec, results) {
        if (this.modeCreateRun && !this.includeAllCasesDuringCreation) {
            for (let i = 0; i < results.tests.length; i++) {
                const test = results.tests[i];
                const testData = new TestData(test);
                const foundCaseIDs = this.testCaseParser.searchCaseId(testData.getTitle());
                foundCaseIDs.forEach(caseId => this.foundCaseIds.push(caseId));
            }

            for (let i = 0; i < this.runIds.length; i++) {
                await this.testrail.updateRun(this.runIds[i], this.foundCaseIds);
            }
        }

        await this._sendSpecResults(spec, results);
    }

    /**
     * Handles after run events.
     * @param {object} afterRunDetails
     * @private
     */
    async _afterRun(afterRunDetails) {
        this.baseURL = afterRunDetails.config.baseUrl;
        this.cypressVersion = afterRunDetails.cypressVersion;
        this.browser = `${afterRunDetails.browserName} (${afterRunDetails.browserVersion})`;
        this.system = `${afterRunDetails.osName} (${afterRunDetails.osVersion})`;
        this.tags = afterRunDetails.config.env.tags;
        this.startedTestsAt = afterRunDetails.startedTestsAt;
        this.endedTestsAt = afterRunDetails.endedTestsAt;
        this.testsExecutionTotalDuration = afterRunDetails.totalDuration;

        if (!this.metadataFilePath) {
            ColorConsole.warn('  TestRail metadata file path not provided.');
            return;
        }

        const options = {
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        };

        const totalDuration = this.testsExecutionTotalDuration;
        const seconds = Math.floor(totalDuration / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;

        const data = {
            testRailRunName: this.runName,
            testRailRunId: this.runIds,
            baseUrl: this.baseURL,
            cypressVersion: this.cypressVersion,
            browser: this.browser,
            system: this.system,
            tags: this.tags,
            startedTestsAt: new Date(this.startedTestsAt).toLocaleString('en-US', options),
            endedTestsAt: new Date(this.endedTestsAt).toLocaleString('en-US', options),
            testsExecutionTotalDuration: `${hours} hours ${remainingMinutes} minutes ${remainingSeconds} seconds`
        };

        let description = '';
        description += 'Tested by Cypress';
        description += `\nEnvironment/ Base URL: ${this.baseURL}`;
        description += `\nCypress Version: ${this.cypressVersion}`;
        description += `\nBrowser: ${this.browser}`;
        description += `\nOS: ${this.system}`;
        description += `\nTesting Type (Tags): ${this.tags}`;
        description += `\nTests Execution Start Time: ${new Date(this.startedTestsAt).toLocaleString('en-US', options)}`;
        description += `\nTests Execution End Time: ${new Date(this.endedTestsAt).toLocaleString('en-US', options)}`;
        description += `\nTests Execution Total Duration: ${hours} hours ${remainingMinutes} minutes ${remainingSeconds} seconds`;

        const jsonData = JSON.stringify(data, null, 2);
        for (let i = 0; i < this.runIds.length; i++) {
            await this.testrail.updateAfterRunMetadata(this.runIds[i], description);
        }

        fs.writeFile(this.metadataFilePath, jsonData, (err) => {
            if (err) {
                ColorConsole.error(`  Error writing TestRail metadata file for run R${this.runIds}: "${err}"`);
            } else {
                ColorConsole.success(`  TestRail metadata for run ID(s) R${this.runIds} saved to file: '${this.metadataFilePath}'`);
            }
        });

        if (this.modeCreateRun) {
            if (this.closeRun) {
                for (let i = 0; i < this.runIds.length; i++) {
                    await this.testrail.closeRun(this.runIds[i], () => {
                        console.log('  TestRail Run: R' + this.runIds[i] + ' is now closed');
                    });
                }
            } else {
                console.log(`  Skipping closing of Test Run: R${this.runIds}`);
            }
        }
    }

    /**
     * Sends test results for a spec file to TestRail.
     * @param {object} spec
     * @param {object} results
     * @private
     */
    async _sendSpecResults(spec, results) {
        if (!results.tests || results.tests.length === 0) {
            return;
        }

        const allRequests = [];
        const allResults = [];

        for (let i = 0; i < results.tests.length; i++) {
            const cyTest = new TestData(results.tests[i]);

            if (cyTest.isPending() && this.ignorePendingTests) {
                ColorConsole.debug('Ignoring pending test: ' + cyTest.getTitle());
                continue;
            }

            const testRailStatusID = this.statusConverter.convertToTestRail(cyTest.getState());
            let screenshotPaths = [];

            if (cyTest.isFailed()) {
                screenshotPaths = this._getScreenshotByTestId(cyTest.getId(), cyTest.getTitle(), results.screenshots);
                if (screenshotPaths === null) {
                    screenshotPaths = [];
                }
            }

            let comment = cyTest.getTitle() ? cyTest.getTitle() : 'Tested by Cypress';

            if (!this.modeCreateRun) {
                comment += `\nCypress: ${this.cypressVersion}`;
                comment += `\nBrowser: ${this.browser}`;
                comment += `\nBase URL: ${this.baseURL}`;
                comment += `\nSystem: ${this.system}`;
                comment += `\nSpec: ${spec.name}`;

                if (this.customComment !== '') {
                    comment += `\n${this.customComment}`;
                }
            }

            if (cyTest.getError() !== '') {
                comment += '\nError: ' + cyTest.getError();
            }

            const foundCaseIDs = this.testCaseParser.searchCaseId(cyTest.getTitle());
            for (let j = 0; j < foundCaseIDs.length; j++) {
                const caseId = foundCaseIDs[j];
                const result = new Result(caseId, testRailStatusID, comment, cyTest.getDurationMS(), screenshotPaths);
                allResults.push(result);
            }
        }

        if (allResults.length > 0) {
            for (let i = 0; i < this.runIds.length; i++) {
                const request = this.testrail.sendBatchResults(this.runIds[i], allResults);
                allRequests.push(request);
            }
            await Promise.all(allRequests);
        }
    }

    /**
     * Creates a new TestRail run.
     * @private
     */
    async _createTestRailRun() {
        const today = new Date();
        const dateTime = today.toLocaleString();
        let runName = this.runName === '' ? 'Cypress Run (__datetime__)' : this.runName;
        runName = runName.replace('__datetime__', dateTime);

        let description = '';
        description += 'Tested by Cypress';
        description += `\nCypress: ${this.cypressVersion}`;
        description += `\nBrowser: ${this.browser}`;
        description += `\nBase URL: ${this.baseURL}`;
        description += `\nSystem: ${this.system}`;

        if (this.customComment !== '') {
            description += `\n${this.customComment}`;
        }

        const me = this;
        await this.testrail.createRun(
            this.projectId,
            this.milestoneId,
            this.suiteId,
            runName,
            description,
            this.includeAllCasesDuringCreation,
            (runId) => {
                this.runIds = [runId];
                ColorConsole.debug('New TestRail Run: R' + runId);

                const data = {
                    id: runId,
                    name: runName,
                    description: description,
                    projectId: me.projectId,
                    milestoneId: me.milestoneId,
                    suiteId: me.suiteId,
                };

                me.fileWriter.write('created_run.json', JSON.stringify(data, null, 2));
            }
        );
    }

    /**
     * Filters and returns screenshots for a specific test.
     * @param {string} testId
     * @param {string} testTitle
     * @param {Array} screenshots
     * @returns {Array}
     * @private
     */
    _getScreenshotByTestId(testId, testTitle, screenshots) {
        // Helper: extract a unique identifier from a string.
        // This finds the first occurrence of letter(s) followed by digit(s)
        const extractIdentifier = (str) => {
            const match = str.match(/[A-Z]+\d+/i);
            return match ? match[0].toLowerCase() : null;
        };

        // Helper: extract a cleaned base name from a file path.
        // Removes extension and trailing suffixes like " (failed)" or " (attempt X)".
        const extractBaseName = (filePath) => {
            const fileName = filePath.split('/').pop();
            let baseName = fileName.replace(/\.[^/.]+$/, ""); // remove extension
            // Remove trailing suffixes (case-insensitive)
            baseName = baseName.replace(/\s*\(failed.*$/i, "").replace(/\s*\(attempt.*\)$/i, "").trim();
            return baseName;
        };

        // Extract a unique identifier from the test title.
        const titleIdentifier = extractIdentifier(testTitle);

        // Filter the screenshots.
        let filteredScreenshots = screenshots.filter(screenshot => {
            // If the screenshot has a testId, use that for an exact match.
            if (screenshot.testId) {
                return screenshot.testId === testId;
            } else {
                // Otherwise, extract the base name from the screenshot's file path.
                const baseName = extractBaseName(screenshot.path).toLowerCase();
                // If we got a unique identifier from the test title, require that the screenshot's
                // base name includes it.
                if (titleIdentifier) {
                    return baseName.includes(titleIdentifier);
                }
                // If no identifier could be extracted, fall back to a strict full-text check.
                return baseName === testTitle.toLowerCase().trim();
            }
        });

        // Further filter to only include screenshots that indicate a failure.
        filteredScreenshots = filteredScreenshots.filter(screenshot =>
            screenshot.path.toLowerCase().includes('(failed')
        );

        // Debug logging (optional)
        // console.log('Test:', testTitle, 'Identifier:', titleIdentifier);
        // console.log('Filtered Screenshots:', filteredScreenshots.map(s => s.path));

        // If the flag to include all failed screenshots is set, return them.
        if (this.includeAllFailedScreenshots) {
            return filteredScreenshots;
        }

        // Otherwise, choose the screenshot with the highest attempt index (i.e. the latest attempt).
        let highestAttempt = -1;
        let latestScreenshot = null;
        filteredScreenshots.forEach(screenshot => {
            const currentAttempt = screenshot.testAttemptIndex || 0;
            if (currentAttempt > highestAttempt) {
                highestAttempt = currentAttempt;
                latestScreenshot = screenshot;
            }
        });

        return latestScreenshot ? [latestScreenshot] : [];
    }
}

module.exports = Reporter;
