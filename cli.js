#!/usr/bin/env node

const Path = require('path');
const fs = require('fs');
const commandExistsSync = require('command-exists').sync;
const which = require('which');
const version = JSON.parse(fs.readFileSync(Path.join(__dirname, 'package.json'), 'utf-8')).version;
const childProcess = require('child_process');
const stripJsonCommands = require('strip-json-comments');
const { mkdirpSync, rmDirRecursiveSync } = require('./helpers');
let program = require('commander');

program
    .version(version)
    .option('-i --input-dir <dir>', 'Input directory (optional, default is current working directory)')
    .option('-o --output-dir <dir>', 'Output directory (optional, default is .vscode)')
    .option('-m --target <target>', 'Compile target MCU (if not set, this is read through Mbed CLI)')
    .option('--debugger <debugger>', 'Debugger, either pyocd or stlink (default is pyocd)')
    .allowUnknownOption(true)
    .parse(process.argv);

console.log('Mbed VSCode generator, v' + version + '\n');

console.log('Verifying dependencies:');

// Check dependencies
if (!commandExistsSync('mbed')) {
    console.error('    ✘ "mbed" not in installed or not in PATH. Install Mbed CLI before continuing.');
    process.exit(1);
}
else {
    console.log('    ✔ Mbed CLI installed');
}

if (!program.inputDir) {
    program.inputDir = process.cwd();
}

program.inputDir = Path.resolve(program.inputDir);

let exporterFiles = [ 'Makefile', 'mbed_config.h', 'GettingStarted.html' ].map(f => Path.join(program.inputDir, f));

if (!fs.existsSync(program.inputDir)) {
    console.error('    ✘ Input directory does not exist (' + program.inputDir + ')');
    process.exit(1);
}
else {
    console.log('    ✔ Input directory exists');
}

for (let f of exporterFiles) {
    if (fs.existsSync(f)) {
        console.error('    ✘ File "' + f + '" exists, would be overwritten by this tool. Remove it to continue.');
        process.exit(1);
    }
}

// Check if GCC_ARM_PATH is set, or if arm-none-eabi-gcc is in PATH
let gccArmPath = null;
if (commandExistsSync('arm-none-eabi-gcc')) {
    gccArmPath = which.sync('arm-none-eabi-gcc');
}
else {
    let configResp = childProcess.spawnSync('mbed', [ 'config', 'GCC_ARM_PATH' ], { cwd: program.inputDir });

    if (configResp.status === 0) {
        gccArmPath = Path.join(configResp.stdout.toString('utf-8').replace(/^\[mbed\] /, '').trim(), 'arm-none-eabi-gcc');

        if (!fs.existsSync(gccArmPath)) {
            console.error(`    ✘ Could not find compiler. GCC_ARM_PATH set, but cannot find "${gccArmPath}"`);
            process.exit(1);
        }
    }
}

if (!gccArmPath) {
    console.error(`    ✘ Could not find compiler. arm-none-eabi-gcc not in PATH and GCC_ARM_PATH not set through Mbed CLI`);
    process.exit(1);
}
else {
    console.log('    ✔ Compiler found (' + gccArmPath + ')');
}

if (!program.debugger) {
    program.debugger = 'pyocd';
}

let debuggerPath = null;

if (program.debugger === 'pyocd') {
    if (commandExistsSync('pyocd-gdbserver')) {
        debuggerPath = which.sync('pyocd-gdbserver');
        console.log('    ✔ Debugger found (' + debuggerPath + ')');
    }
    else {
        console.error(`    ✘ Could not find debugger. pyocd-gdbserver not in PATH`);
        process.exit(1);
    }
}
else if (program.debugger === 'stlink') {
    if (commandExistsSync('st-util')) {
        debuggerPath = which.sync('st-util');
        console.log('    ✔ Debugger found (' + debuggerPath + ')');
    }
    else {
        console.error(`    ✘ Could not find debugger. st-util not in PATH`);
        process.exit(1);
    }
}
else {
    console.error(`    ✘ Debugger should be "pyocd" or "stlink", but was "${program.debugger}"`);
    process.exit(1);
}

if (!program.target) {
    // find target via Mbed CLI
    let findTarget = childProcess.spawnSync('mbed', [ 'target' ], { cwd: program.inputDir });
    if (findTarget.status !== 0) {
        console.error(`    ✘ Could not detect target through Mbed CLI. Pass in "-m TARGET_NAME"`);
        process.exit(1);
    }

    let lines = findTarget.stdout.toString('utf-8').split('\n').map(f => f.trim()).filter(f => !!f);
    program.target = lines[lines.length - 1].replace(/^\[mbed\] /, '').trim();

    console.log('    ✔ Target configured through Mbed CLI (' + program.target + ')');
}
else {
    console.log('    ✔ Target configured (' + program.target + ')');
}

if (!program.outputDir) {
    program.outputDir = Path.join(process.cwd(), '.vscode');
}

if (!fs.existsSync(program.outputDir)) {
    mkdirpSync(program.outputDir);
}

program.outputDir = Path.resolve(program.outputDir);

console.log('');
console.log('Input directory is "' + program.inputDir + '"');
console.log('Output directory is "' + program.outputDir + '"');
console.log('');

// Let's run the exporter...
(function() {
    let ranToSuccess = false;

    try {
        console.log('Generating .vscode directory:')
        let exportArgs = [ 'export', '-i', 'make_gcc_arm' ];
        if (program.target) {
            exportArgs.push('-m');
            exportArgs.push(program.target);
        }

        let exportCmd = childProcess.spawnSync('mbed', exportArgs, { cwd: program.inputDir });
        if (exportCmd.status !== 0) {
            console.error('    ✘ Exporting to make_gcc_arm failed (see below)');
            console.error('');
            console.error(exportCmd.stdout.toString('utf-8'));
            console.error(exportCmd.stderr.toString('utf-8'));
            return;
        }

        let makefile = Path.join(program.inputDir, 'Makefile');
        if (!fs.existsSync(makefile)) {
            console.error('    ✘ Makefile does not exist (' + makefile + ')');
            return;
        }

        let mbedconfig = Path.join(program.inputDir, 'mbed_config.h');
        if (!fs.existsSync(mbedconfig)) {
            console.error('    ✘ mbed_config.h does not exist (' + mbedconfig + ')');
            return;
        }

        console.log('    ✔ Exporting succeeded');

        // export symbols from Makefile
        let makefileContent = fs.readFileSync(makefile, 'utf-8').split('\n').map(l => l.trim());

        let includePaths = [];
        for (let includePathLine of makefileContent.filter(l => l.indexOf('INCLUDE_PATHS += -I') === 0)) {
            includePathLine = includePathLine.replace('INCLUDE_PATHS += -I', '');
            includePathLine = Path.resolve(Path.join(program.inputDir, 'mbed-os'), includePathLine);
            includePaths.push(includePathLine);
        }

        console.log('    ✔ Extracting include paths (' + includePaths.length + ' items)');

        // export defines from Makefile...
        let defines = [];
        for (let defineLine of makefileContent.filter(l => l.indexOf('C_FLAGS += -D') === 0)) {
            defineLine = defineLine.replace('C_FLAGS += -D', '');
            defines.push(defineLine);
        }

        // export defines from mbed_config.h
        let mbedconfigContent = fs.readFileSync(mbedconfig, 'utf-8').split('\n').map(l => l.trim());
        for (let defineLine of mbedconfigContent.filter(l => l.indexOf('#define ') === 0)) {
            defineLine = defineLine.replace('#define ', '');
            if (defineLine.indexOf('//') > -1) {
                defineLine = defineLine.split('//')[0].trim();
            }
            let d = defineLine.split(/\s+/);

            if (d.length === 1) {
                defines.push(d[0]);
            }
            else {
                defines.push(d[0] + '=' + d[1]);
            }
        }

        console.log('    ✔ Extracting defines (' + defines.length + ' items)');

        // do we already have a c_cpp_properties.json file?
        let cppPropPath = Path.join(program.outputDir, 'c_cpp_properties.json');
        let cppProp = null;
        if (fs.existsSync(cppPropPath)) {
            cppProp = JSON.parse(stripJsonCommands(fs.readFileSync(cppPropPath, 'utf-8')));

            console.log('    ✔ Loading existing c_cpp_properties.json');
        }
        else {
            cppProp = {
                configurations: [],
                version: 4
            };
        }

        let config = cppProp.configurations.filter(c => c.name === 'Mbed')[0];
        if (!config) {
            // don't override below so the user can modify this
            config = { name: 'Mbed', cStandard: 'c99', cppStandard: 'c++03', intelliSenseMode: 'gcc-x64' };
            cppProp.configurations.push(config);
        }

        config.compilerPath = gccArmPath;
        config.includePath = includePaths;
        config.defines = defines;

        fs.writeFileSync(cppPropPath, JSON.stringify(cppProp, null, 4), 'utf-8');

        console.log('    ✔ Creating c_cpp_properties.json');

        // Create build task
        let tasksPath = Path.join(program.outputDir, 'tasks.json');
        let tasks = null;
        if (fs.existsSync(tasksPath)) {
            tasks = JSON.parse(stripJsonCommands(fs.readFileSync(tasksPath, 'utf-8')));

            console.log('    ✔ Loading existing tasks.json');
        }
        else {
            tasks = {
                version: "2.0.0",
                tasks: []
            };
        }

        let task = (tasks.tasks || []).filter(c => c.command === 'mbed' && c.group === 'build')[0];
        if (!task) {
            // don't override below so the user can modify this
            task = {
                "type": "shell",
                "label": "Build Mbed OS application",
                "command": "mbed",
                "windows": {
                    "command": "mbed.exe"
                },
                "options": {
                },
                "group": "build",
                "problemMatcher": {
                    "owner": "cpp",
                    "pattern": {
                        "regexp": "^(.*):(\\d+):(\\d+):\\s+(warning|error):\\s+(.*)$",
                        "file": 1,
                        "line": 2,
                        "column": 3,
                        "severity": 4,
                        "message": 5
                    }
                },
                "presentation": {
                    "echo": true,
                    "reveal": "always",
                    "focus": false,
                    "panel": "shared",
                    "showReuseMessage": true,
                    "clear": false
                },
                "args": ["compile"]
            };
            if (program.target) {
                task.args = [ 'compile', '-m', program.target, '--profile=debug' ];
            }
            tasks.tasks.push(task);
        }

        task.options = task.options || {};
        task.options.cwd = program.inputDir;
        task.problemMatcher = task.problemMatcher || {};
        task.problemMatcher.fileLocation = [ 'relative', program.inputDir ];

        fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 4), 'utf-8');

        console.log('    ✔ Creating tasks.json');


        // Creating launch.json
        let launchPath = Path.join(program.outputDir, 'launch.json');
        let launch = null;
        if (fs.existsSync(launchPath)) {
            launch = JSON.parse(stripJsonCommands(fs.readFileSync(launchPath, 'utf-8')));

            console.log('    ✔ Loading existing launch.json');
        }
        else {
            launch = {
                version: "0.2.0",
                configurations: []
            };
        }

        let launchConfig = launch.configurations.filter(c => c.name === 'Debug Mbed')[0];
        if (!launchConfig) {
            let programName = Path.basename(program.inputDir);
            let elfFile = Path.join(program.inputDir, 'BUILD', program.target, 'GCC_ARM-DEBUG', programName + '.elf');
            let gdbPath = Path.join(Path.dirname(gccArmPath), 'arm-none-eabi-gdb');
            if (process.platform === "win32") {
                gdbPath += '.exe';
            }

            let remote, serverStarted;

            switch (program.debugger) {
                case 'pyocd':
                    remote = 'localhost:3333';
                    serverStarted = 'GDB\\ server\\ started';
                    break;

                case 'stlink':
                    remote = 'localhost:4242';
                    serverStarted = 'Listening\\ at';
                    break;

                default:
                    throw 'Unsupported debugger ' + program.debugger;
            }

            // don't override below so the user can modify this
            launchConfig = {
                "name": "Debug Mbed",
                "type": "cppdbg",
                "request": "launch",
                "program": elfFile,
                "args": [],
                "stopAtEntry": true,
                "cwd": program.inputDir,
                "environment": [],
                "externalConsole": false,
                "debugServerArgs": "",
                "serverLaunchTimeout": 20000,
                "filterStderr": true,
                "filterStdout": false,
                "serverStarted": serverStarted,
                "preLaunchTask": "Build Mbed OS application",
                "setupCommands": [
                    {
                        "text": "-target-select remote " + remote,
                        "description": "connect to target",
                        "ignoreFailures": false
                    },
                    {
                        "text": "-file-exec-and-symbols " + elfFile,
                        "description": "load file",
                        "ignoreFailures": false
                    },
                    {
                        "text": "-interpreter-exec console \"monitor reset\"",
                        "description": "reset monitor",
                        "ignoreFailures": false
                    },
                    {
                        "text": "-interpreter-exec console \"monitor halt\"",
                        "description": "halt monitor",
                        "ignoreFailures": false
                    },
                    {
                        "text": "-target-download",
                        "description": "flash target",
                        "ignoreFailures": false
                    }
                ],
                "logging": {
                    "moduleLoad": true,
                    "trace": true,
                    "engineLogging": true,
                    "programOutput": true,
                    "exceptions": true
                },
                "linux": {
                    "MIMode": "gdb",
                    "MIDebuggerPath": gdbPath,
                    "debugServerPath": debuggerPath,
                },
                "osx": {
                    "MIMode": "gdb",
                    "MIDebuggerPath": gdbPath,
                    "debugServerPath": debuggerPath,
                },
                "windows": {
                    "MIMode": "gdb",
                    "MIDebuggerPath": gdbPath,
                    "debugServerPath": debuggerPath,
                    "setupCommands": [
                        {
                            "text": "-environment-cd " + Path.dirname(elfFile),
                            "description": "go to right folder"
                        },
                        {
                            "text": "-target-select remote " + remote,
                            "description": "connect to target",
                            "ignoreFailures": false
                        },
                        {
                            "text": "-file-exec-and-symbols " + programName + ".elf",
                            "description": "load file",
                            "ignoreFailures": false
                        },
                        {
                            "text": "-interpreter-exec console \"monitor reset\"",
                            "description": "reset monitor",
                            "ignoreFailures": false
                        },
                        {
                            "text": "-interpreter-exec console \"monitor halt\"",
                            "description": "halt monitor",
                            "ignoreFailures": false
                        },
                        {
                            "text": "-target-download",
                            "description": "flash target",
                            "ignoreFailures": false
                         }
                    ]
                }
            };

            launch.configurations.push(launchConfig);

            // only write whenever this happened, never overwrite launch.json
            fs.writeFileSync(launchPath, JSON.stringify(launch, null, 4), 'utf-8');

            console.log('    ✔ Creating launch.json');
        }

        ranToSuccess = true;
    }
    catch (ex) {
        console.log('An error occured when generating the .vscode directory', ex);
        ranToSuccess = false;
    }
    finally {
        // remove exporter files
        for (let f of exporterFiles) {
            if (fs.existsSync(f)) {
                fs.unlinkSync(f);
            }
        }
    }

    if (!ranToSuccess) {
        process.exit(1);
    }
    else {
        process.exit(0);
    }
})();
