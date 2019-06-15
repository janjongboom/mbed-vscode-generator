const Path = require('path');
const fs = require('fs');

const mkdirpSync = function(targetDir) {
    const sep = Path.sep;
    const initDir = Path.isAbsolute(targetDir) ? sep : '';
    const baseDir = '.';

    targetDir.split(sep).reduce((parentDir, childDir) => {
        const curDir = Path.resolve(baseDir, parentDir, childDir);
        if (!fs.existsSync(curDir)) {
            fs.mkdirSync(curDir);
        }
        return curDir;
    }, initDir);
};

const rmDirRecursiveSync = function(path) {
    if (!fs.existsSync(path)) return;

    for (let file of fs.readdirSync(path)) {
        let currPath = Path.join(path, file);
        if (fs.lstatSync(currPath).isDirectory()) {
            rmDirRecursiveSync(currPath);
        } else { // delete file
            fs.unlinkSync(currPath);
        }
    }
    fs.rmdirSync(path);
};

module.exports = {
    mkdirpSync: mkdirpSync,
    rmDirRecursiveSync: rmDirRecursiveSync
};
