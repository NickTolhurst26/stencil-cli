'use strict';

const MEGABYTE = 1048576;
const MAX_SIZE_BUNDLE = MEGABYTE * 50;
const PATHS_TO_ZIP = [
    {
        pattern: 'assets/**/*',
        ignore: [
            'assets/cdn/**',
            'assets/**/*.js.map',
        ],
    },
    { pattern: 'CHANGELOG.md' },
    { pattern: 'config.json' },
    { pattern: '.eslintrc' },
    { pattern: '.eslintignore' },
    { pattern: 'Gruntfile.js' },
    { pattern: 'karma.conf.js' },
    { pattern: 'lang/*' },
    { pattern: 'meta/**/*' },
    { pattern: 'package.json' },
    { pattern: 'README.md' },
    { pattern: '.scss-lint.yml' },
    { pattern: 'stencil.conf.js' },
    { pattern: 'templates/**/*' },
    { pattern: 'webpack.*.js' },
];

const Upath = require('upath');
const Readdir = require('recursive-readdir');
const Archiver = require('archiver');
const Async = require('async');
const Crypto = require('crypto');
const Fs = require('fs');
const Path = require('path');
const BuildConfigManager = require('./BuildConfigManager');
const BundleValidator = require('./bundle-validator');
const Cycles = require('./Cycles');
const CssAssembler = require('./css-assembler');
const LangAssembler = require('./lang-assembler');
const TemplateAssembler = require('./template-assembler');
const Regions = require('./regions');

function Bundle(
    themePath,
    themeConfig,
    rawConfig,
    options,
    buildConfigManger = new BuildConfigManager(),
) {
    const tasks = {};
    this.options = options || {};

    this.templatesPath = Path.join(themePath, 'templates');
    this.themePath = themePath;
    this.themeConfig = themeConfig;
    this.configuration = rawConfig;

    this.validator = new BundleValidator(this.themePath, this.themeConfig, this.options.marketplace !== true);

    if (this.configuration.css_compiler) {
        tasks.css = this.getCssAssembleTask(this.configuration.css_compiler);
    }

    tasks.templates = this.assembleTemplatesTask.bind(this);
    tasks.lang = this.assembleLangTask.bind(this);
    tasks.schema = this.assembleSchema.bind(this);
    tasks.schemaTranslations = this.assembleSchemaTranslations.bind(this);

    if (typeof buildConfigManger.production === 'function') {
        tasks.theme = callback => {
            console.log('Theme task Started...');
            buildConfigManger.initWorker().production(err => {
                if (err) {
                    return callback(err);
                }

                console.log('ok'.green + ' -- Theme task Finished');
                callback();
            });
        };
    }

    this.tasks = tasks;
}

/**
 * Initializes bundling process and executes all required tasks.
 * @param {Function} callback
 */
Bundle.prototype.initBundle = function (callback) {
    Async.series({
        validate: validateTheme.bind(this),
        bundle: bundleTaskRunner.bind(this),
    }, (err, result) => {
        let errorMessage = '';

        if (err) {
            errorMessage = err.message ? err.message : String(err);
            console.error('failed  -- '.red + errorMessage.red);
            return callback(err);
        }

        callback(null, result.bundle);
    });
};

Bundle.prototype.getCssAssembleTask = function (compiler) {
    const assembleOptions = {
        bundle: true,
    };
    return callback => {
        const basePath = Path.join(this.themePath, 'assets', compiler);

        console.log('%s Parsing Started...', compiler.toUpperCase());
        Fs.readdir(basePath, (err, files) => {
            const filterFiles = files.filter(file => {
                return file.substr(-(compiler.length + 1)) === '.' + compiler;
            });
            Async.map(filterFiles, (file, mapCallback) => {
                CssAssembler.assemble(file, basePath, compiler, assembleOptions, mapCallback);
            }, (err, results) => {
                const ret = {};
                if (err) {
                    return callback(err);
                }

                filterFiles.forEach((file, index) => {
                    ret[file] = results[index];
                });

                console.log('ok'.green + ' -- %s Parsing Finished', compiler.toUpperCase());
                callback(null, ret);
            });
        });
    };
};

Bundle.prototype.assembleTemplatesTask = function (callback) {
    console.log('Template Parsing Started...');

    Readdir(this.templatesPath, ['!*.html'], (err, files) => {
        if (err) {
            return callback(err);
        }

        const partials = files.map(file => {
            return Upath.toUnix(file.replace(this.templatesPath + Path.sep, '').replace(/\.html$/, ''));
        });

        Async.map(partials, TemplateAssembler.assembleAndBundle.bind(null, this.templatesPath), (err, results) => {
            const ret = {};

            if (err) {
                return callback(err);
            }

            partials.forEach((file, index) => {
                ret[file] = results[index];
            });

            Async.parallel([
                checkObjects.bind(this, results),
                detectCycles.bind(this, results),
            ], err => {
                if (err) {
                    callback(err);
                }

                console.log('ok'.green + ' -- Template Parsing Finished');
                callback(null, ret);
            });
        });
    });
};

Bundle.prototype.assembleSchema = function (callback) {
    console.log('Building Theme Schema File...');

    this.themeConfig.getSchema((err, schema) => {
        if (err) {
            callback(err);
        }

        console.log('ok'.green + ' -- Theme Schema Building Finished');

        callback(null, schema);
    });
};

Bundle.prototype.assembleSchemaTranslations = function (callback) {
    console.log('Schema Translations Parsing Started...');

    this.themeConfig.getSchemaTranslations((err, schema) => {
        if (err) {
            callback(err);
        }

        console.log('ok'.green + ' -- Schema Translations Parsing Finished');

        callback(null, schema);
    });
};

Bundle.prototype.assembleLangTask = function (callback) {
    console.log('Language Files Parsing Started...');
    LangAssembler.assemble((err, results) => {
        if (err) {
            return callback(err);
        }

        console.log('ok'.green + ' -- Language Files Parsing Finished');
        callback(null, results);
    });
};

Bundle.prototype.generateManifest = function (taskResults, callback) {
    console.log('Generating Manifest Started...');

    Readdir(this.templatesPath, ['!*.html'], (err, filePaths) => {
        if (err) {
            return callback(err);
        }

        const templates = filePaths.map(file => {
            return Upath.toUnix(file.replace(this.templatesPath + Path.sep, '').replace('.html', ''));
        });

        const regions = Regions.fetchRegions(taskResults.templates, templates);

        console.log('ok'.green + ' -- Manifest Generation Finished');
        return callback(null, {
            regions,
            templates,
        });
    });
};

function checkObjects(results, callback) {
    this.validator.validateObjects(results, err => {
        if (err) {
            console.error('error '.red + err.message);
            return callback(err);
        }

        callback();
    });
}

function detectCycles(results, callback) {
    try {
        new Cycles(results).detect();
        callback();
    } catch (err) {
        callback(err);
    }
}

function validateTheme(callback) {
    console.log("Validating theme...");
    this.validator.validateTheme(err => {
        if (err) {
            throw err;
        }

        callback(null, true);
    });
}

function bundleTaskRunner(callback) {
    let defaultName = this.configuration.name
        ? this.configuration.name + '-' + this.configuration.version + '.zip'
        : 'Theme.zip';
    const outputName = typeof this.options.name === 'string' ? this.options.name + '.zip' : defaultName;
    const outputFolder = typeof this.options.dest === 'string' ? this.options.dest : this.themePath;
    const bundleZipPath = Path.join(outputFolder, outputName);

    Async.parallel(this.tasks, (err, taskResults) => {
        if (err) {
            return callback(err);
        }

        const archive = Archiver('zip');
        const fileStream = Fs.createWriteStream(bundleZipPath);
        archive.pipe(fileStream);

        // Create manifest will use taskResults to generate a manifest file
        this.generateManifest(taskResults, (err, manifest) => {
            if (err) {
                return callback(err);
            }

            taskResults.manifest = manifest;
            // zip theme files
            bundleThemeFiles(archive, this.themePath);

            // zip all generated files
            const failedTemplates = bundleParsedFiles(archive, taskResults);

            fileStream.on('close', () => {
                const stats = Fs.statSync(bundleZipPath);
                const size = stats['size'];

                if (failedTemplates.length) {
                    return console.error(`Error: Your bundle failed as templates generated from the files below are greater than or equal to 1 megabyte in size:\n${failedTemplates.join('\n')}`);
                }

                if (size > MAX_SIZE_BUNDLE) {
                    return console.error(`Error: Your bundle of size ${size} bytes is above the max size of ${MAX_SIZE_BUNDLE} bytes`);
                }

                console.log('ok'.green + ' -- Zipping Files Finished');

                return callback(null, bundleZipPath);
            });

            // This triggers 'close' event in the file stream. No need to callback()
            archive.finalize();
        });
    });
}

/**
 * Archive theme files
 * @param {Archiver} archive
 * @param {String} themePath
 */
function bundleThemeFiles(archive, themePath) {
    PATHS_TO_ZIP.forEach(({ pattern, ignore }) =>
        archive.glob(pattern, { ignore, cwd: themePath }),
    );
}

/**
 * Archive all generated files (ex. parsed files)
 * @param {Archiver} archive
 * @param {Object} taskResults
 * @returns {Array}
 */
function bundleParsedFiles(archive, taskResults) {
    const archiveJsonFile = (data, name) => {
        archive.append(JSON.stringify(data, null, 2), { name });
    };
    const failedTemplates = [];
    for (let task in taskResults) {
        let data = taskResults[task];
        switch(task) {
            case 'css':
                // Create the parsed tree files
                for (let filename in data) {
                    archiveJsonFile(data[filename], `parsed/scss/${filename}.json`);
                }
                break;

            case 'templates':
                // Create the parsed tree files
                for (let filename in data) {
                    const hash = Crypto.createHash('md5').update(filename).digest('hex');
                    const fileData = data[filename];
                    archiveJsonFile(fileData, `parsed/templates/${hash}.json`);
                    // if file size is greater than 1 megabyte push filename to failedTemplates
                    if (JSON.stringify(fileData).length >= MEGABYTE) {
                        failedTemplates.push(filename);
                    }
                }
                break;

            case 'lang':
                // append the parsed translation file with all translations
                archiveJsonFile(data, 'parsed/lang.json');
                break;

            case 'schema':
                // append the generated schema.json file
                archiveJsonFile(data, 'schema.json');
                break;

            case 'schemaTranslations':
                // append the parsed schemaTranslations.json file
                archiveJsonFile(data, 'schemaTranslations.json');
                break;

            case 'manifest':
                // append the generated manifest.json file
                archiveJsonFile(data, 'manifest.json');
                break;
        }
    }
    return failedTemplates;
}

module.exports = Bundle;
