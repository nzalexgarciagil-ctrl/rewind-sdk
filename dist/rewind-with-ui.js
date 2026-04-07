// Rewind SDK v1.1.0 - Built 2026-04-07
// https://github.com/nzalexgarciagil-ctrl/rewind-sdk

// --- core/bridge.js ---
// sdk/core/bridge.js - JS <-> ExtendScript communication bridge (SDK version)
// Factory: accepts CSInterface instance, returns Bridge API

var RewindBridge = (function() {
    'use strict';

    function create(csInterface, options) {
        var cs = csInterface;
        var hostFnName = (options && options.hostFunctionName) || 'RewindHost_handleMessage';

        var ALLOWED_COMMANDS = {
            getProjectPath: true,
            saveProject: true,
            closeProject: true,
            openProject: true,
            closeAndReopenProject: true
        };

        function callHost(type, data) {
            return new Promise(function(resolve, reject) {
                if (!ALLOWED_COMMANDS[type]) {
                    reject(new Error('Unknown command: ' + type));
                    return;
                }

                var dataStr = data ? JSON.stringify(data) : '{}';
                dataStr = dataStr
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n')
                    .replace(/\r/g, '\\r')
                    .replace(/\t/g, '\\t');

                var script = hostFnName + "('" + type + "', \"" + dataStr + "\")";

                cs.evalScript(script, function(response) {
                    if (!response || response === 'undefined' || response === 'null' || response === 'EvalScript error.') {
                        var hint = '';
                        if (response === 'EvalScript error.') {
                            hint = ' Check that rewind-host.jsx is configured as your ScriptPath in manifest.xml.';
                        }
                        reject(new Error('ExtendScript call failed for "' + type + '".' + hint));
                        return;
                    }
                    try {
                        var parsed = JSON.parse(response);
                        if (parsed.error) {
                            reject(new Error(parsed.error));
                        } else {
                            resolve(parsed.result);
                        }
                    } catch (e) {
                        resolve(response);
                    }
                });
            });
        }

        return {
            callHost: callHost,
            cs: cs
        };
    }

    return { create: create };
})();


// --- core/prproj-handler.js ---
// sdk/core/prproj-handler.js - Decompress/recompress .prproj files (SDK version)
// Stateless module, no dependencies beyond cep_node

var RewindPrprojHandler = (function() {
    'use strict';

    var zlib = cep_node.require('zlib');
    var fs = cep_node.require('fs');

    function decompress(prprojPath) {
        return new Promise(function(resolve, reject) {
            fs.readFile(prprojPath, function(err, buffer) {
                if (err) {
                    reject(new Error('Cannot read prproj: ' + err.message));
                    return;
                }
                try {
                    var xml = zlib.gunzipSync(buffer);
                    resolve(xml.toString('utf8'));
                } catch (e) {
                    var text = buffer.toString('utf8');
                    if (text.indexOf('<?xml') === 0 || text.indexOf('<PremiereData') !== -1) {
                        resolve(text);
                    } else {
                        reject(new Error('Cannot decompress prproj: ' + e.message));
                    }
                }
            });
        });
    }

    function compress(xmlString, outputPath) {
        return new Promise(function(resolve, reject) {
            try {
                var compressed = zlib.gzipSync(Buffer.from(xmlString, 'utf8'));
                fs.writeFile(outputPath, compressed, function(err) {
                    if (err) {
                        reject(new Error('Cannot write prproj: ' + err.message));
                    } else {
                        resolve();
                    }
                });
            } catch (e) {
                reject(new Error('Cannot compress prproj: ' + e.message));
            }
        });
    }

    return {
        decompress: decompress,
        compress: compress
    };
})();


// --- core/git-manager.js ---
// sdk/core/git-manager.js - Git operations via child_process.execFile (SDK version)
// Factory: accepts optional config, returns GitManager API

var RewindGitManager = (function() {
    'use strict';

    var childProcess = cep_node.require('child_process');
    var fs = cep_node.require('fs');

    function create(options) {
        var GIT_EXE = (options && options.gitPath) || 'git';

        function runGit(repoPath, args) {
            return new Promise(function(resolve, reject) {
                childProcess.execFile(GIT_EXE, args, {
                    cwd: repoPath,
                    maxBuffer: 50 * 1024 * 1024,
                    windowsHide: true
                }, function(err, stdout, stderr) {
                    if (err) {
                        var msg = 'git ' + args[0] + ' failed: ' + (stderr || err.message);
                        if (err.code === 'ENOENT') {
                            msg = 'Git not found at "' + GIT_EXE + '". Install Git and ensure it is in your PATH.';
                        }
                        console.error('rewind: ' + msg);
                        reject(new Error(msg));
                    } else {
                        resolve(stdout.trim());
                    }
                });
            });
        }

        function mkdirp(dirPath) {
            return new Promise(function(resolve, reject) {
                fs.mkdir(dirPath, { recursive: true }, function(err) {
                    // Ignore EEXIST for Node < 10.12 where recursive option doesn't exist
                    if (err && err.code !== 'EEXIST') reject(err);
                    else resolve();
                });
            });
        }

        function init(repoPath) {
            console.log('rewind: git init in ' + repoPath);
            return mkdirp(repoPath).then(function() {
                return runGit(repoPath, ['init']);
            }).then(function() {
                return runGit(repoPath, ['config', 'user.email', 'rewind@local']);
            }).then(function() {
                return runGit(repoPath, ['config', 'user.name', 'rewind']);
            });
        }

        function commit(repoPath, message) {
            return runGit(repoPath, ['add', '-A']).then(function() {
                return runGit(repoPath, ['commit', '-m', message || 'Snapshot']);
            }).then(function(output) {
                console.log('rewind: git commit ok — ' + (message || 'Snapshot'));
                return output;
            });
        }

        function log(repoPath, maxCount) {
            var count = maxCount || 50;
            var format = '%H%n%s%n%ai%n%ar';
            return runGit(repoPath, ['log', '--format=' + format, '-n', String(count)]).then(function(output) {
                if (!output) return [];
                var lines = output.split('\n');
                var commits = [];
                for (var i = 0; i + 3 < lines.length; i += 4) {
                    commits.push({
                        hash: lines[i],
                        message: lines[i + 1],
                        date: lines[i + 2],
                        dateRelative: lines[i + 3]
                    });
                }
                return commits;
            }).catch(function() {
                return [];
            });
        }

        function checkout(repoPath, commitHash, filePath) {
            return runGit(repoPath, ['checkout', commitHash, '--', filePath || '.']);
        }

        function diffStat(repoPath, commitHash) {
            return runGit(repoPath, ['diff', '--stat', commitHash]).catch(function() {
                return '';
            });
        }

        function hasChanges(repoPath) {
            return runGit(repoPath, ['status', '--porcelain']).then(function(output) {
                return output.length > 0;
            }).catch(function() {
                return false;
            });
        }

        function getHead(repoPath) {
            return runGit(repoPath, ['rev-parse', 'HEAD']).catch(function() {
                return null;
            });
        }

        function commitCount(repoPath) {
            return runGit(repoPath, ['rev-list', '--count', 'HEAD']).then(function(out) {
                return parseInt(out, 10) || 0;
            }).catch(function() {
                return 0;
            });
        }

        function createBranch(repoPath, branchName) {
            return runGit(repoPath, ['checkout', '-b', branchName]);
        }

        function switchBranch(repoPath, branchName) {
            return runGit(repoPath, ['checkout', branchName]);
        }

        function listBranches(repoPath) {
            return runGit(repoPath, ['branch', '--list']).then(function(output) {
                if (!output) return [];
                return output.split('\n').map(function(line) {
                    var current = line.charAt(0) === '*';
                    var name = line.replace(/^\*?\s+/, '').trim();
                    return { name: name, current: current };
                }).filter(function(b) { return b.name; });
            }).catch(function() {
                return [];
            });
        }

        function getCurrentBranch(repoPath) {
            return runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(function() {
                return 'master';
            });
        }

        function deleteBranch(repoPath, branchName) {
            return runGit(repoPath, ['branch', '-D', branchName]);
        }

        function showFile(repoPath, commitHash, filePath) {
            return runGit(repoPath, ['show', commitHash + ':' + filePath]).catch(function() {
                return null;
            });
        }

        return {
            runGit: runGit,
            init: init,
            commit: commit,
            log: log,
            checkout: checkout,
            diffStat: diffStat,
            hasChanges: hasChanges,
            getHead: getHead,
            commitCount: commitCount,
            createBranch: createBranch,
            switchBranch: switchBranch,
            listBranches: listBranches,
            getCurrentBranch: getCurrentBranch,
            deleteBranch: deleteBranch,
            showFile: showFile
        };
    }

    return { create: create };
})();


// --- core/github-manager.js ---
// sdk/core/github-manager.js - GitHub integration (SDK version)
// Factory: accepts GitManager instance, returns GitHubManager API

var RewindGitHubManager = (function() {
    'use strict';

    var https = cep_node.require('https');
    var fs = cep_node.require('fs');
    var path = cep_node.require('path');
    var os = cep_node.require('os');
    var crypto = cep_node.require('crypto');
    var childProcess = cep_node.require('child_process');

    function create(gitManager) {
        var CREDENTIALS_DIR = path.join(os.homedir(), '.rewind');
        var CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'credentials.json');
        var OLD_CREDENTIALS_DIR = path.join(os.homedir(), '.ppgit');
        var OLD_CREDENTIALS_FILE = path.join(OLD_CREDENTIALS_DIR, 'credentials.json');
        var GITHUB_API = 'api.github.com';

        var cachedToken = null;
        var cachedUser = null;

        // --- Migration ---
        function migrateCredentials() {
            try {
                if (!fs.existsSync(CREDENTIALS_FILE) && fs.existsSync(OLD_CREDENTIALS_FILE)) {
                    if (!fs.existsSync(CREDENTIALS_DIR)) {
                        fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
                    }
                    fs.copyFileSync(OLD_CREDENTIALS_FILE, CREDENTIALS_FILE);
                }
            } catch (e) {}
        }

        migrateCredentials();

        // --- Helpers ---
        function githubRequest(method, apiPath, token, body) {
            return new Promise(function(resolve, reject) {
                var options = {
                    hostname: GITHUB_API,
                    path: apiPath,
                    method: method,
                    headers: {
                        'User-Agent': 'rewind-sdk/1.1.0',
                        'Accept': 'application/vnd.github.v3+json',
                        'Authorization': 'Bearer ' + token
                    }
                };
                if (body) {
                    options.headers['Content-Type'] = 'application/json';
                }

                var req = https.request(options, function(res) {
                    var data = '';
                    res.on('data', function(chunk) { data += chunk; });
                    res.on('end', function() {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try { resolve(data ? JSON.parse(data) : null); }
                            catch (e) { resolve(data); }
                        } else {
                            var msg = 'GitHub API error ' + res.statusCode;
                            try {
                                var parsed = JSON.parse(data);
                                if (parsed.message) msg += ': ' + parsed.message;
                            } catch (e) {}
                            reject(new Error(msg));
                        }
                    });
                });

                req.on('error', function(err) {
                    reject(new Error('Network error: ' + err.message));
                });
                req.setTimeout(15000, function() {
                    req.destroy();
                    reject(new Error('GitHub API request timed out'));
                });

                if (body) req.write(JSON.stringify(body));
                req.end();
            });
        }

        function getMachineId() {
            try { return os.hostname() + '-' + os.userInfo().username; }
            catch (e) { return 'rewind-default-key'; }
        }

        function encryptToken(token) {
            var salt = crypto.randomBytes(16);
            var key = crypto.scryptSync(getMachineId(), salt, 32);
            var iv = crypto.randomBytes(16);
            var cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            var encrypted = cipher.update(token, 'utf8', 'hex') + cipher.final('hex');
            return { encrypted: encrypted, iv: iv.toString('hex'), salt: salt.toString('hex') };
        }

        function decryptToken(data) {
            try {
                if (data.plaintext) {
                    // Legacy base64 tokens: decrypt and re-encrypt properly on next save
                    return Buffer.from(data.plaintext, 'base64').toString('utf8');
                }
                // Support legacy hardcoded salt for existing installs
                var salt = data.salt ? Buffer.from(data.salt, 'hex') : 'ppgit-salt';
                var key = crypto.scryptSync(getMachineId(), salt, 32);
                var iv = Buffer.from(data.iv, 'hex');
                var decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                return decipher.update(data.encrypted, 'hex', 'utf8') + decipher.final('utf8');
            } catch (e) { return null; }
        }

        // --- Credential Storage ---
        function saveCredentials(token, user) {
            try {
                if (!fs.existsSync(CREDENTIALS_DIR)) {
                    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
                }
                var data = { token: encryptToken(token), user: user, savedAt: new Date().toISOString() };
                fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
            } catch (e) {
                console.error('rewind: Failed to save credentials:', e.message);
            }
        }

        function loadCredentials() {
            try {
                if (!fs.existsSync(CREDENTIALS_FILE)) return null;
                var raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
                var data = JSON.parse(raw);
                var token = decryptToken(data.token);
                if (!token) return null;
                return { token: token, user: data.user };
            } catch (e) { return null; }
        }

        function clearCredentials() {
            try { if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE); }
            catch (e) {}
            cachedToken = null;
            cachedUser = null;
        }

        // --- Authentication ---
        function authenticate(token) {
            return githubRequest('GET', '/user', token).then(function(user) {
                cachedToken = token;
                cachedUser = {
                    login: user.login,
                    name: user.name || user.login,
                    avatar: user.avatar_url,
                    email: user.email
                };
                saveCredentials(token, cachedUser);
                return cachedUser;
            });
        }

        function getToken() {
            if (cachedToken) return cachedToken;
            var creds = loadCredentials();
            if (creds) { cachedToken = creds.token; cachedUser = creds.user; return cachedToken; }
            return null;
        }

        function isAuthenticated() { return !!getToken(); }

        function getUser() {
            if (cachedUser) return cachedUser;
            var creds = loadCredentials();
            if (creds) { cachedUser = creds.user; return cachedUser; }
            return null;
        }

        function logout() { clearCredentials(); }

        // --- Repository Management ---
        function sanitizeRepoName(name) {
            return name
                .replace(/\.prproj$/i, '')
                .replace(/[^a-zA-Z0-9._-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .toLowerCase()
                .substring(0, 80);
        }

        function createRepo(projectName) {
            var token = getToken();
            if (!token) return Promise.reject(new Error('Not authenticated'));
            var repoName = 'rewind-' + sanitizeRepoName(projectName);
            return githubRequest('POST', '/user/repos', token, {
                name: repoName,
                description: 'Rewind backup: ' + projectName,
                private: true,
                auto_init: false
            }).then(function(repo) {
                return {
                    name: repo.name, fullName: repo.full_name,
                    url: repo.clone_url, htmlUrl: repo.html_url, sshUrl: repo.ssh_url
                };
            });
        }

        function repoExists(repoName) {
            var token = getToken();
            if (!token) return Promise.reject(new Error('Not authenticated'));
            var user = getUser();
            if (!user) return Promise.reject(new Error('No user info'));
            return githubRequest('GET', '/repos/' + user.login + '/' + repoName, token)
                .then(function() { return true; })
                .catch(function(err) {
                    if (err.message && err.message.indexOf('404') !== -1) return false;
                    throw err;
                });
        }

        function getOrCreateRepo(projectName) {
            var repoName = 'rewind-' + sanitizeRepoName(projectName);
            var token = getToken();
            if (!token) return Promise.reject(new Error('Not authenticated'));
            var user = getUser();
            if (!user) return Promise.reject(new Error('No user info'));
            return repoExists(repoName).then(function(exists) {
                if (exists) {
                    return {
                        name: repoName,
                        fullName: user.login + '/' + repoName,
                        url: 'https://github.com/' + user.login + '/' + repoName + '.git'
                    };
                }
                return createRepo(projectName);
            });
        }

        // --- Git operations with auth (credential helper, no token in URL) ---
        function runGitAuth(repoPath, args) {
            var token = getToken();
            return new Promise(function(resolve, reject) {
                var execArgs = args;
                var env = Object.assign({}, process.env);
                if (token) {
                    env.GIT_TERMINAL_PROMPT = '0';
                    execArgs = [
                        '-c', 'credential.helper=!f() { echo "username=x-access-token"; echo "password=' + token.replace(/'/g, "'\\''") + '"; }; f'
                    ].concat(args);
                }
                childProcess.execFile('git', execArgs, {
                    cwd: repoPath,
                    maxBuffer: 50 * 1024 * 1024,
                    windowsHide: true,
                    env: env
                }, function(err, stdout, stderr) {
                    if (err) {
                        reject(new Error('git ' + args[0] + ' failed: ' + (stderr || err.message)));
                    } else {
                        resolve(stdout.trim());
                    }
                });
            });
        }

        // --- Remote Operations ---
        function setupRemote(repoPath, remoteUrl) {
            // Store clean URL without token — auth is handled per-command via credential helper
            return gitManager.runGit(repoPath, ['remote', 'get-url', 'origin']).then(function(existingUrl) {
                // Strip any legacy embedded token from existing URL
                var cleanExisting = existingUrl.replace(/https:\/\/[^@]+@/, 'https://');
                if (cleanExisting !== remoteUrl) {
                    return gitManager.runGit(repoPath, ['remote', 'set-url', 'origin', remoteUrl]);
                }
            }).catch(function() {
                return gitManager.runGit(repoPath, ['remote', 'add', 'origin', remoteUrl]);
            });
        }

        function push(repoPath) {
            return gitManager.getCurrentBranch(repoPath).then(function(branch) {
                return runGitAuth(repoPath, ['push', '-u', 'origin', branch]);
            }).catch(function(err) {
                if (err.message.indexOf('has no upstream') !== -1 || err.message.indexOf('does not appear to be a git') !== -1) {
                    return gitManager.getCurrentBranch(repoPath).then(function(branch) {
                        return runGitAuth(repoPath, ['push', '--set-upstream', 'origin', branch]);
                    });
                }
                throw err;
            });
        }

        function pull(repoPath) {
            return gitManager.getCurrentBranch(repoPath).then(function(branch) {
                return runGitAuth(repoPath, ['pull', '--rebase', 'origin', branch]);
            }).catch(function(err) {
                if (err.message.indexOf("couldn't find remote ref") !== -1 ||
                    err.message.indexOf('no tracking information') !== -1) return '';
                throw err;
            });
        }

        function sync(repoPath) {
            return pull(repoPath).then(function() { return push(repoPath); });
        }

        function hasRemote(repoPath) {
            return gitManager.runGit(repoPath, ['remote', 'get-url', 'origin'])
                .then(function(url) { return !!url; })
                .catch(function() { return false; });
        }

        function getRemoteUrl(repoPath) {
            return gitManager.runGit(repoPath, ['remote', 'get-url', 'origin']).catch(function() { return null; });
        }

        return {
            authenticate: authenticate,
            isAuthenticated: isAuthenticated,
            getToken: getToken,
            getUser: getUser,
            logout: logout,
            createRepo: createRepo,
            repoExists: repoExists,
            getOrCreateRepo: getOrCreateRepo,
            sanitizeRepoName: sanitizeRepoName,
            setupRemote: setupRemote,
            push: push,
            pull: pull,
            sync: sync,
            hasRemote: hasRemote,
            getRemoteUrl: getRemoteUrl
        };
    }

    return { create: create };
})();


// --- core/diff-engine.js ---
// sdk/core/diff-engine.js - Human-readable diff summaries for .prproj XML (SDK version)
// Stateless module, no external dependencies

var RewindDiffEngine = (function() {
    'use strict';

    function normalize(xml) {
        return xml
            .replace(/<ModifiedTime>[^<]*<\/ModifiedTime>/g, '')
            .replace(/<CreateTime>[^<]*<\/CreateTime>/g, '')
            .replace(/<MZ\.Sequence\.EditInProgress>[^<]*<\/MZ\.Sequence\.EditInProgress>/g, '')
            .replace(/<CacheFilePath>[^<]*<\/CacheFilePath>/g, '')
            .replace(/<PeakFilePath>[^<]*<\/PeakFilePath>/g, '')
            .replace(/<RenderFilePath>[^<]*<\/RenderFilePath>/g, '')
            .replace(/<PreviewRenderFilePath>[^<]*<\/PreviewRenderFilePath>/g, '')
            .replace(/<FrameBlendHash>[^<]*<\/FrameBlendHash>/g, '')
            .replace(/\s+SaveVersion="[^"]*"/g, '')
            .replace(/\s+ModifiedInVersion="[^"]*"/g, '')
            .replace(/\n\s*\n\s*\n/g, '\n\n');
    }

    function extractSequences(xml) {
        var sequences = [];
        var seqRegex = /<Sequence[^>]*>([\s\S]*?)<\/Sequence>/g;
        var match;

        while ((match = seqRegex.exec(xml)) !== null) {
            var seqContent = match[1];
            var nameMatch = seqContent.match(/<Name>([^<]+)<\/Name>/);
            var name = nameMatch ? nameMatch[1] : 'Unnamed Sequence';
            sequences.push({
                name: name,
                content: seqContent,
                hash: simpleHash(seqContent)
            });
        }

        if (sequences.length === 0) {
            var trackRegex = /<VideoTrack[^>]*>([\s\S]*?)<\/VideoTrack>/g;
            var trackCount = 0;
            while ((match = trackRegex.exec(xml)) !== null) {
                trackCount++;
            }
            if (trackCount > 0) {
                sequences.push({
                    name: 'Timeline',
                    content: xml,
                    hash: simpleHash(xml)
                });
            }
        }

        return sequences;
    }

    function simpleHash(str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            var char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }

    function lineDiffCount(textA, textB) {
        var linesA = textA.split('\n');
        var linesB = textB.split('\n');
        var setA = {};
        var setB = {};
        var i;

        for (i = 0; i < linesA.length; i++) {
            var lineA = linesA[i].trim();
            if (lineA) setA[lineA] = (setA[lineA] || 0) + 1;
        }
        for (i = 0; i < linesB.length; i++) {
            var lineB = linesB[i].trim();
            if (lineB) setB[lineB] = (setB[lineB] || 0) + 1;
        }

        var changes = 0;
        var allKeys = {};
        Object.keys(setA).forEach(function(k) { allKeys[k] = true; });
        Object.keys(setB).forEach(function(k) { allKeys[k] = true; });

        Object.keys(allKeys).forEach(function(k) {
            var countA = setA[k] || 0;
            var countB = setB[k] || 0;
            changes += Math.abs(countA - countB);
        });

        return changes;
    }

    function compare(xmlOld, xmlNew) {
        var normOld = normalize(xmlOld);
        var normNew = normalize(xmlNew);

        if (normOld === normNew) {
            return {
                totalChanges: 0,
                sequences: [],
                projectSettings: { changed: false, count: 0 },
                summary: 'No meaningful changes detected'
            };
        }

        var seqsOld = extractSequences(normOld);
        var seqsNew = extractSequences(normNew);

        var oldByName = {};
        seqsOld.forEach(function(s) { oldByName[s.name] = s; });
        var newByName = {};
        seqsNew.forEach(function(s) { newByName[s.name] = s; });

        var sequenceResults = [];
        var totalChanges = 0;

        seqsOld.forEach(function(oldSeq) {
            var newSeq = newByName[oldSeq.name];
            if (!newSeq) {
                sequenceResults.push({ name: oldSeq.name, status: 'removed', changes: 0 });
                totalChanges++;
            } else if (oldSeq.hash !== newSeq.hash) {
                var changeCount = lineDiffCount(oldSeq.content, newSeq.content);
                sequenceResults.push({ name: oldSeq.name, status: 'modified', changes: changeCount });
                totalChanges += changeCount;
            }
        });

        seqsNew.forEach(function(newSeq) {
            if (!oldByName[newSeq.name]) {
                sequenceResults.push({ name: newSeq.name, status: 'added', changes: 0 });
                totalChanges++;
            }
        });

        var projOld = normOld;
        var projNew = normNew;
        seqsOld.forEach(function(s) { projOld = projOld.replace(s.content, ''); });
        seqsNew.forEach(function(s) { projNew = projNew.replace(s.content, ''); });
        var projChanges = lineDiffCount(projOld, projNew);
        totalChanges += projChanges;

        var summaryParts = [];
        sequenceResults.forEach(function(s) {
            if (s.status === 'modified') {
                summaryParts.push(s.changes + ' changes in "' + s.name + '"');
            } else if (s.status === 'added') {
                summaryParts.push('"' + s.name + '" added');
            } else if (s.status === 'removed') {
                summaryParts.push('"' + s.name + '" removed');
            }
        });
        if (projChanges > 0) {
            summaryParts.push(projChanges + ' project setting changes');
        }
        if (summaryParts.length === 0 && totalChanges === 0) {
            summaryParts.push('No meaningful changes detected');
        } else if (summaryParts.length === 0) {
            summaryParts.push(totalChanges + ' changes detected');
        }

        return {
            totalChanges: totalChanges,
            sequences: sequenceResults,
            projectSettings: { changed: projChanges > 0, count: projChanges },
            summary: summaryParts.join(', ')
        };
    }

    return {
        normalize: normalize,
        compare: compare,
        extractSequences: extractSequences
    };
})();


// --- core/version-controller.js ---
// sdk/core/version-controller.js - Main orchestration (SDK version)
// Factory: accepts deps object { Bridge, GitManager, GitHubManager, PrprojHandler, DiffEngine }

var RewindVersionController = (function() {
    'use strict';

    var fs = cep_node.require('fs');
    var path = cep_node.require('path');

    function create(deps) {
        function writeFileAsync(filePath, data, encoding) {
            return new Promise(function(resolve, reject) {
                fs.writeFile(filePath, data, encoding, function(err) {
                    if (err) reject(err); else resolve();
                });
            });
        }
        function readFileAsync(filePath, encoding) {
            return new Promise(function(resolve, reject) {
                fs.readFile(filePath, encoding, function(err, data) {
                    if (err) reject(err); else resolve(data);
                });
            });
        }

        function waitForFileRelease(filePath) {
            var start = Date.now();
            return new Promise(function(resolve) {
                function check() {
                    fs.open(filePath, 'r+', function(err, fd) {
                        if (!err && fd !== undefined) {
                            fs.close(fd, function() { resolve(); });
                        } else if (Date.now() - start > FILE_RELEASE_TIMEOUT_MS) {
                            log.warn('file release timeout, proceeding anyway');
                            resolve();
                        } else {
                            setTimeout(check, FILE_RELEASE_POLL_MS);
                        }
                    });
                }
                if (!fs.existsSync(filePath)) { resolve(); return; }
                check();
            });
        }

        var Bridge = deps.Bridge;
        var GitManager = deps.GitManager;
        var GitHubManager = deps.GitHubManager || null;
        var PrprojHandler = deps.PrprojHandler;
        var DiffEngine = deps.DiffEngine || null;

        var log = deps.logger || {
            log: function(msg) { console.log('rewind: ' + msg); },
            warn: function(msg) { console.warn('rewind: ' + msg); },
            error: function(msg) { console.error('rewind: ' + msg); }
        };

        var VC_DIR_NAME = deps.vcDirName || '.rewind';
        var OLD_VC_DIR_NAME = '.ppgit';
        var XML_FILENAME = 'project.xml';
        var SETTINGS_FILENAME = 'settings.json';
        var BRANCHES_FILENAME = 'branches.json';
        var LABELS_FILENAME = 'labels.json';
        var POLL_INTERVAL = 5000;
        var FILE_RELEASE_POLL_MS = 200;
        var FILE_RELEASE_TIMEOUT_MS = 5000;

        var state = {
            projectPath: null,
            projectDir: null,
            vcDir: null,
            repoPath: null,
            xmlPath: null,
            initialized: false,
            pollTimer: null,
            dirtyTimer: null,
            operationInProgress: false,
            currentBranch: 'master',
            branches: {},
            labels: {},
            lastSavedAt: null,
            settings: {
                autoSaveIntervalSeconds: 60,
                autoPush: false
            }
        };

        var listeners = [];

        function emit(event, data) {
            listeners.forEach(function(fn) { fn(event, data); });
        }

        function on(fn) {
            listeners.push(fn);
        }

        function off(fn) {
            var idx = listeners.indexOf(fn);
            if (idx !== -1) listeners.splice(idx, 1);
        }

        function ensureGitignore() {
            try {
                var giPath = path.join(state.vcDir, '.gitignore');
                var content = 'settings.json\nbranches.json\nlabels.json\n';
                if (!fs.existsSync(giPath)) {
                    fs.writeFileSync(giPath, content);
                }
            } catch (e) {}
        }

        function migrateFromPpgit() {
            if (!state.projectDir) return;
            var oldDir = path.join(state.projectDir, OLD_VC_DIR_NAME);
            var newDir = path.join(state.projectDir, VC_DIR_NAME);
            try {
                if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                    fs.renameSync(oldDir, newDir);
                }
            } catch (e) {}
        }

        // --- Settings ---
        function loadSettings() {
            try {
                var settingsPath = path.join(state.vcDir, SETTINGS_FILENAME);
                if (fs.existsSync(settingsPath)) {
                    var raw = fs.readFileSync(settingsPath, 'utf8');
                    var loaded = JSON.parse(raw);
                    Object.keys(loaded).forEach(function(k) {
                        if (state.settings.hasOwnProperty(k)) state.settings[k] = loaded[k];
                    });
                }
            } catch (e) {}
        }

        function saveSettings(newSettings) {
            Object.keys(newSettings).forEach(function(k) {
                if (state.settings.hasOwnProperty(k)) state.settings[k] = newSettings[k];
            });
            try {
                var settingsPath = path.join(state.vcDir, SETTINGS_FILENAME);
                fs.writeFileSync(settingsPath, JSON.stringify(state.settings, null, 2));
            } catch (e) {}
            setupDirtyPoll();
            emit('settings-changed', state.settings);
        }

        // --- Branches ---
        function loadBranches() {
            try {
                var fp = path.join(state.vcDir, BRANCHES_FILENAME);
                if (fs.existsSync(fp)) {
                    state.branches = JSON.parse(fs.readFileSync(fp, 'utf8'));
                } else {
                    state.branches = { master: { displayName: 'Main Edit', createdAt: new Date().toISOString() } };
                    saveBranches();
                }
            } catch (e) {
                state.branches = { master: { displayName: 'Main Edit', createdAt: new Date().toISOString() } };
            }
        }

        function saveBranches() {
            try {
                var fp = path.join(state.vcDir, BRANCHES_FILENAME);
                fs.writeFileSync(fp, JSON.stringify(state.branches, null, 2));
            } catch (e) {}
        }

        // --- Labels ---
        function loadLabels() {
            try {
                var fp = path.join(state.vcDir, LABELS_FILENAME);
                if (fs.existsSync(fp)) {
                    state.labels = JSON.parse(fs.readFileSync(fp, 'utf8'));
                } else {
                    state.labels = {};
                }
            } catch (e) { state.labels = {}; }
        }

        function saveLabels() {
            try {
                var fp = path.join(state.vcDir, LABELS_FILENAME);
                fs.writeFileSync(fp, JSON.stringify(state.labels, null, 2));
            } catch (e) {}
        }

        function addLabel(commitHash, label) {
            if (!label || !label.trim()) {
                delete state.labels[commitHash];
            } else {
                state.labels[commitHash] = label.trim();
            }
            saveLabels();
            emit('labels-changed', state.labels);
        }

        function getLabels() {
            return Object.assign({}, state.labels);
        }

        // --- Initialize ---
        function initialize() {
            log.log('initializing...');
            return Bridge.callHost('getProjectPath').then(function(projectPath) {
                if (!projectPath) throw new Error('No project is currently open');

                state.projectPath = path.normalize(projectPath);
                state.projectDir = path.dirname(state.projectPath);
                log.log('project path = ' + state.projectPath);

                migrateFromPpgit();

                state.vcDir = path.join(state.projectDir, VC_DIR_NAME);
                state.repoPath = state.vcDir;
                state.xmlPath = path.join(state.vcDir, XML_FILENAME);

                if (!fs.existsSync(state.vcDir)) {
                    fs.mkdirSync(state.vcDir, { recursive: true });
                }

                ensureGitignore();
                loadSettings();
                loadBranches();
                loadLabels();

                return GitManager.init(state.repoPath);
            }).then(function() {
                return GitManager.getCurrentBranch(state.repoPath);
            }).then(function(branch) {
                log.log('on branch ' + branch);
                state.currentBranch = branch;
                if (!state.branches[branch]) {
                    state.branches[branch] = {
                        displayName: branch === 'master' ? 'Main Edit' : branch,
                        createdAt: new Date().toISOString()
                    };
                    saveBranches();
                }
                return GitManager.commitCount(state.repoPath);
            }).then(function(count) {
                if (count > 0) return null;
                return doSnapshot('Initial snapshot');
            }).then(function() {
                state.initialized = true;
                log.log('initialized successfully');
                setupDirtyPoll();
                startProjectPoll();
                emit('initialized', {
                    projectPath: state.projectPath,
                    branch: state.currentBranch,
                    version: getVersionDisplayName()
                });
                return state;
            });
        }

        // --- Snapshot ---
        function doSnapshot(message) {
            if (state.operationInProgress) return Promise.resolve(null);
            log.log('snapshot starting');
            state.operationInProgress = true;
            return PrprojHandler.decompress(state.projectPath).then(function(xml) {
                return writeFileAsync(state.xmlPath, xml, 'utf8');
            }).then(function() {
                return GitManager.hasChanges(state.repoPath);
            }).then(function(changed) {
                if (!changed) {
                    log.log('no changes detected');
                    state.operationInProgress = false;
                    return null;
                }
                return GitManager.commit(state.repoPath, message || 'Snapshot').then(function() {
                    log.log('committed');
                    state.lastSavedAt = new Date();
                    state.operationInProgress = false;
                    emit('snapshot', { message: message });
                    if (state.settings.autoPush && GitHubManager && GitHubManager.isAuthenticated()) {
                        GitHubManager.push(state.repoPath).catch(function(err) { log.warn('auto-push failed: ' + err.message); });
                    }
                    return true;
                });
            }).catch(function(err) {
                log.error('snapshot failed: ' + err.message);
                state.operationInProgress = false;
                throw err;
            });
        }

        function snapshot(message) {
            if (state.operationInProgress) return Promise.resolve(null);
            emit('busy', true);
            return Bridge.callHost('saveProject').then(function() {
                return new Promise(function(r) { setTimeout(r, 500); });
            }).then(function() {
                return doSnapshot(message || 'Manual snapshot');
            }).then(function(committed) {
                emit('busy', false);
                return committed;
            }).catch(function(err) {
                emit('busy', false);
                throw err;
            });
        }

        // --- Restore ---
        function restore(commitHash) {
            if (state.operationInProgress) return Promise.resolve(null);
            log.log('restoring to ' + commitHash);
            state.operationInProgress = true;
            emit('busy', true);

            var restoredXml;
            var savedProjectPath = state.projectPath;

            return Bridge.callHost('saveProject').then(function() {
                return new Promise(function(r) { setTimeout(r, 500); });
            }).then(function() {
                return PrprojHandler.decompress(state.projectPath);
            }).then(function(xml) {
                return writeFileAsync(state.xmlPath, xml, 'utf8').then(function() {
                    return GitManager.hasChanges(state.repoPath);
                });
            }).then(function(changed) {
                if (changed) return GitManager.commit(state.repoPath, 'Auto-save before restore');
            }).then(function() {
                return GitManager.checkout(state.repoPath, commitHash, XML_FILENAME);
            }).then(function() {
                restoredXml = fs.readFileSync(state.xmlPath, 'utf8');
            }).then(function() {
                return GitManager.commit(state.repoPath, 'Restored to ' + commitHash.substring(0, 7));
            }).then(function() {
                log.log('closing project');
                return Bridge.callHost('closeProject');
            }).then(function() {
                return waitForFileRelease(savedProjectPath);
            }).then(function() {
                return PrprojHandler.compress(restoredXml, state.projectPath);
            }).then(function() {
                // Verify the file was written
                try {
                    var stat = fs.statSync(state.projectPath);
                    if (stat.size === 0) {
                        throw new Error('Restored .prproj file is empty (0 bytes)');
                    }
                    log.log('restored .prproj written (' + Math.round(stat.size / 1024) + 'KB)');
                } catch (e) {
                    throw new Error('Failed to verify restored .prproj: ' + e.message);
                }
            }).then(function() {
                log.log('reopening project');
                return Bridge.callHost('openProject', { path: savedProjectPath });
            }).then(function() {
                state.initialized = true;
                state.operationInProgress = false;
                state.lastSavedAt = new Date();
                setupDirtyPoll();
                log.log('restore complete');
                emit('restored', { hash: commitHash });
                emit('busy', false);
            }).catch(function(err) {
                log.error('restore failed: ' + err.message);
                state.operationInProgress = false;
                emit('busy', false);
                throw err;
            });
        }

        // --- Branching ---
        function doSnapshotUnsafe(message) {
            return PrprojHandler.decompress(state.projectPath).then(function(xml) {
                return writeFileAsync(state.xmlPath, xml, 'utf8');
            }).then(function() {
                return GitManager.hasChanges(state.repoPath);
            }).then(function(changed) {
                if (!changed) return null;
                return GitManager.commit(state.repoPath, message || 'Snapshot').then(function() {
                    state.lastSavedAt = new Date();
                    return true;
                });
            });
        }

        function createVersion(displayName) {
            log.log('creating version ' + displayName);
            if (state.operationInProgress) return Promise.reject(new Error('Operation in progress'));
            state.operationInProgress = true;
            emit('busy', true);

            var gitBranch = displayName
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .substring(0, 50);
            if (!gitBranch) gitBranch = 'version-' + Date.now();

            var baseName = gitBranch;
            var counter = 2;
            while (state.branches[gitBranch]) {
                gitBranch = baseName + '-' + counter;
                counter++;
            }

            return Bridge.callHost('saveProject').then(function() {
                return new Promise(function(r) { setTimeout(r, 500); });
            }).then(function() {
                return doSnapshotUnsafe('Snapshot before creating "' + displayName + '"');
            }).then(function() {
                return GitManager.createBranch(state.repoPath, gitBranch);
            }).then(function() {
                state.currentBranch = gitBranch;
                state.branches[gitBranch] = { displayName: displayName, createdAt: new Date().toISOString() };
                saveBranches();
                state.operationInProgress = false;
                emit('version-created', { branch: gitBranch, displayName: displayName });
                emit('busy', false);
                return { branch: gitBranch, displayName: displayName };
            }).catch(function(err) {
                log.error('createVersion failed: ' + err.message);
                state.operationInProgress = false;
                emit('busy', false);
                throw err;
            });
        }

        function switchVersion(gitBranch) {
            if (state.operationInProgress) return Promise.reject(new Error('Operation in progress'));
            if (gitBranch === state.currentBranch) return Promise.resolve(null);
            log.log('switching to version ' + gitBranch);
            state.operationInProgress = true;
            emit('busy', true);

            var targetName = state.branches[gitBranch] ? state.branches[gitBranch].displayName : gitBranch;
            var savedProjectPath = state.projectPath;
            var switchXml;

            return Bridge.callHost('saveProject').then(function() {
                return new Promise(function(r) { setTimeout(r, 500); });
            }).then(function() {
                return doSnapshotUnsafe('Auto-save before switching to "' + targetName + '"');
            }).then(function() {
                return GitManager.switchBranch(state.repoPath, gitBranch).catch(function() {
                    return GitManager.switchBranch(state.repoPath, gitBranch);
                });
            }).then(function() {
                return readFileAsync(state.xmlPath, 'utf8');
            }).then(function(xml) {
                switchXml = xml;
                return Bridge.callHost('closeProject');
            }).then(function() {
                return waitForFileRelease(savedProjectPath);
            }).then(function() {
                return PrprojHandler.compress(switchXml, state.projectPath);
            }).then(function() {
                // Verify the file was written
                try {
                    var stat = fs.statSync(state.projectPath);
                    if (stat.size === 0) {
                        throw new Error('Restored .prproj file is empty (0 bytes)');
                    }
                    log.log('restored .prproj written (' + Math.round(stat.size / 1024) + 'KB)');
                } catch (e) {
                    throw new Error('Failed to verify restored .prproj: ' + e.message);
                }
            }).then(function() {
                return Bridge.callHost('openProject', { path: savedProjectPath });
            }).then(function() {
                state.currentBranch = gitBranch;
                state.initialized = true;
                state.operationInProgress = false;
                state.lastSavedAt = new Date();
                setupDirtyPoll();
                emit('version-switched', { branch: gitBranch, displayName: getVersionDisplayName() });
                emit('busy', false);
            }).catch(function(err) {
                log.error('switchVersion failed: ' + err.message);
                state.operationInProgress = false;
                emit('busy', false);
                throw err;
            });
        }

        function listVersions() {
            return GitManager.listBranches(state.repoPath).then(function(gitBranches) {
                return gitBranches.map(function(b) {
                    var info = state.branches[b.name] || { displayName: b.name, createdAt: null };
                    return {
                        branch: b.name,
                        displayName: info.displayName,
                        createdAt: info.createdAt,
                        current: b.current
                    };
                });
            });
        }

        function deleteVersion(gitBranch) {
            if (gitBranch === state.currentBranch) return Promise.reject(new Error('Cannot delete the current version'));
            if (gitBranch === 'master') return Promise.reject(new Error('Cannot delete the main version'));
            return GitManager.deleteBranch(state.repoPath, gitBranch).then(function() {
                delete state.branches[gitBranch];
                saveBranches();
                emit('version-deleted', { branch: gitBranch });
            });
        }

        function getVersionDisplayName(branch) {
            var b = branch || state.currentBranch;
            if (state.branches[b]) return state.branches[b].displayName;
            return b === 'master' ? 'Main Edit' : b;
        }

        function getCurrentVersion() {
            return { branch: state.currentBranch, displayName: getVersionDisplayName() };
        }

        // --- Diffs ---
        function getDiff(hashA, hashB) {
            if (!DiffEngine) {
                return Promise.resolve({ totalChanges: 0, summary: 'Diff engine not available' });
            }
            var xmlA, xmlB;
            return GitManager.showFile(state.repoPath, hashA, XML_FILENAME).then(function(xml) {
                xmlA = xml;
                return GitManager.showFile(state.repoPath, hashB, XML_FILENAME);
            }).then(function(xml) {
                xmlB = xml;
                if (!xmlA || !xmlB) return { totalChanges: 0, summary: 'Cannot compare versions' };
                return DiffEngine.compare(xmlA, xmlB);
            }).catch(function(err) {
                return { totalChanges: 0, summary: 'Diff failed: ' + err.message };
            });
        }

        // --- History ---
        function getHistory(count) {
            if (!state.initialized || !state.repoPath) return Promise.resolve([]);
            return GitManager.log(state.repoPath, count || 50);
        }

        // --- Auto-save ---
        function setupDirtyPoll() {
            if (state.dirtyTimer) { clearInterval(state.dirtyTimer); state.dirtyTimer = null; }
            var seconds = state.settings.autoSaveIntervalSeconds;
            if (!seconds || seconds <= 0 || !state.projectPath) {
                log.log('auto-save disabled');
                return;
            }
            log.log('auto-save every ' + seconds + ' seconds');

            state.dirtyTimer = setInterval(function() {
                if (!state.initialized || state.operationInProgress) return;
                Bridge.callHost('saveProject').then(function() {
                    return new Promise(function(r) { setTimeout(r, 500); });
                }).then(function() {
                    return doSnapshot('Auto-snapshot');
                }).then(function(committed) {
                    if (committed) emit('auto-snapshot', {});
                }).catch(function(err) { log.warn('auto-save failed: ' + err.message); });
            }, seconds * 1000);
        }

        // --- Project Poll ---
        function startProjectPoll() {
            if (state.pollTimer) clearInterval(state.pollTimer);
            state.pollTimer = setInterval(function() {
                if (state.operationInProgress) return;
                Bridge.callHost('getProjectPath').then(function(currentPath) {
                    if (!currentPath) {
                        if (state.initialized) { cleanup(); emit('project-closed', {}); }
                        return;
                    }
                    currentPath = path.normalize(currentPath);
                    if (state.projectPath && currentPath !== state.projectPath) {
                        cleanup();
                        emit('project-switched', { newPath: currentPath });
                        initialize().catch(function(err) { log.warn('re-init for new project failed: ' + err.message); });
                    }
                }).catch(function() {
                    // ExtendScript call failed — PPro might be busy, this is normal
                });
            }, POLL_INTERVAL);
        }

        // --- Cleanup ---
        function cleanup() {
            if (state.dirtyTimer) { clearInterval(state.dirtyTimer); state.dirtyTimer = null; }
            if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
            state.initialized = false;
        }

        function destroy() {
            cleanup();
            listeners.length = 0;
        }

        function isTracked() {
            if (!state.projectPath) return false;
            var dir = path.dirname(state.projectPath);
            return fs.existsSync(path.join(dir, VC_DIR_NAME)) || fs.existsSync(path.join(dir, OLD_VC_DIR_NAME));
        }

        return {
            initialize: initialize,
            snapshot: snapshot,
            restore: restore,
            getHistory: getHistory,
            saveSettings: saveSettings,
            getSettings: function() { return Object.assign({}, state.settings); },
            getState: function() {
                return {
                    initialized: state.initialized,
                    projectPath: state.projectPath,
                    currentBranch: state.currentBranch,
                    currentVersion: getVersionDisplayName(),
                    lastSavedAt: state.lastSavedAt
                };
            },
            getRepoPath: function() { return state.repoPath; },
            isTracked: isTracked,
            on: on,
            off: off,
            destroy: destroy,
            createVersion: createVersion,
            switchVersion: switchVersion,
            listVersions: listVersions,
            deleteVersion: deleteVersion,
            getCurrentVersion: getCurrentVersion,
            addLabel: addLabel,
            getLabels: getLabels,
            getDiff: getDiff
        };
    }

    return { create: create };
})();


// --- SDK Entry Point ---
// rewind.js - Rewind SDK entry point
// Include this single file to add version control to any Premiere Pro CEP extension.
//
// Usage:
//   <script src="rewind-sdk/rewind.js"></script>
//   <script>
//     var rewind = RewindSDK.init({ autoSaveInterval: 60 });
//     // Or mount the full UI:
//     RewindSDK.mountUI('#my-panel');
//   </script>

(function() {
    'use strict';

    if (typeof cep_node === 'undefined') {
        throw new Error(
            'Rewind SDK requires Adobe CEP with Node.js enabled. ' +
            'Add --enable-nodejs and --mixed-context to your manifest.xml CEFCommandLine.'
        );
    }
    if (typeof CSInterface === 'undefined') {
        throw new Error(
            'Rewind SDK requires CSInterface.js to be loaded first. ' +
            'Add <script src="path/to/CSInterface.js"></script> before rewind.js.'
        );
    }

    

    // Load SDK sub-modules synchronously via cep_node
    var fs = cep_node.require('fs');
    var nodePath = cep_node.require('path');

    

    // --- SDK Facade ---

    var instance = null;
    var modules = null;

    /**
     * Initialize the Rewind SDK.
     *
     * @param {object} config
     * @param {number} [config.autoSaveInterval=60] - Auto-save interval in seconds (0 to disable)
     * @param {boolean} [config.autoPush=false] - Auto-push to GitHub after snapshots
     * @param {string} [config.gitPath='git'] - Custom git executable path
     * @param {string} [config.vcDirName='.rewind'] - Custom version control directory name
     * @param {string} [config.hostFunctionName='handleMessage'] - ExtendScript host function name
     * @param {CSInterface} [config.csInterface] - CSInterface instance (auto-created if omitted)
     * @param {function} [config.onEvent] - Event callback: function(eventName, data)
     * @returns {object} Rewind SDK instance
     */
    function init(config) {
        config = config || {};

        if (instance) {
            console.warn('rewind: RewindSDK.init() called again. Destroying previous instance.');
            instance.destroy();
        }

        // Create CSInterface (user can pass their own)
        var cs = config.csInterface || new CSInterface();

        // Wire up modules via dependency injection
        var bridge = RewindBridge.create(cs, {
            hostFunctionName: config.hostFunctionName
        });

        var gitManager = RewindGitManager.create({
            gitPath: config.gitPath
        });

        var githubManager = RewindGitHubManager.create(gitManager);

        var versionController = RewindVersionController.create({
            Bridge: bridge,
            GitManager: gitManager,
            GitHubManager: githubManager,
            PrprojHandler: RewindPrprojHandler,
            DiffEngine: RewindDiffEngine,
            vcDirName: config.vcDirName
        });

        // Apply config overrides
        if (config.autoSaveInterval !== undefined || config.autoPush !== undefined) {
            var settingsOverride = {};
            if (config.autoSaveInterval !== undefined) {
                settingsOverride.autoSaveIntervalSeconds = config.autoSaveInterval;
            }
            if (config.autoPush !== undefined) {
                settingsOverride.autoPush = config.autoPush;
            }
            // These will be applied after initialize() loads existing settings
            versionController.on(function(event) {
                if (event === 'initialized') {
                    versionController.saveSettings(settingsOverride);
                }
            });
        }

        // Wire up user's event callback
        if (typeof config.onEvent === 'function') {
            versionController.on(config.onEvent);
        }

        modules = {
            Bridge: bridge,
            GitManager: gitManager,
            GitHubManager: githubManager,
            PrprojHandler: RewindPrprojHandler,
            DiffEngine: RewindDiffEngine,
            VersionController: versionController
        };

        // Build the public instance
        instance = {
            // --- Lifecycle ---
            /** Start tracking the current project */
            start: function() {
                return versionController.initialize();
            },
            /** Stop tracking and clean up timers */
            destroy: function() {
                versionController.destroy();
                instance._destroyed = true;
                instance = null;
                modules = null;
            },

            // --- Snapshots ---
            /** Create a manual snapshot with optional label */
            snapshot: function(message) {
                return versionController.snapshot(message);
            },
            /** Restore project to a previous snapshot */
            restore: function(commitHash) {
                return versionController.restore(commitHash);
            },
            /** Get snapshot history */
            getHistory: function(count) {
                return versionController.getHistory(count);
            },

            // --- Versions (Branches) ---
            /** Create a new named version from current state */
            createVersion: function(name) {
                return versionController.createVersion(name);
            },
            /** Switch to a different version */
            switchVersion: function(branch) {
                return versionController.switchVersion(branch);
            },
            /** List all versions */
            listVersions: function() {
                return versionController.listVersions();
            },
            /** Delete a version */
            deleteVersion: function(branch) {
                return versionController.deleteVersion(branch);
            },
            /** Get the current version info */
            getCurrentVersion: function() {
                return versionController.getCurrentVersion();
            },

            // --- Labels ---
            /** Add or update a label on a snapshot */
            addLabel: function(hash, label) {
                return versionController.addLabel(hash, label);
            },
            /** Get all labels */
            getLabels: function() {
                return versionController.getLabels();
            },

            // --- Diffs ---
            /** Compare two snapshots */
            getDiff: function(hashA, hashB) {
                return versionController.getDiff(hashA, hashB);
            },

            // --- Settings ---
            /** Get current settings */
            getSettings: function() {
                return versionController.getSettings();
            },
            /** Update settings */
            saveSettings: function(settings) {
                return versionController.saveSettings(settings);
            },

            // --- State ---
            /** Get current tracking state */
            getState: function() {
                return versionController.getState();
            },
            /** Check if current project has tracking initialized */
            isTracked: function() {
                return versionController.isTracked();
            },
            /** Get the .rewind repo path */
            getRepoPath: function() {
                return versionController.getRepoPath();
            },

            // --- Events ---
            /**
             * Listen for events.
             * Events: initialized, snapshot, auto-snapshot, restored, busy,
             *         project-closed, project-switched, version-created,
             *         version-switched, version-deleted, labels-changed,
             *         settings-changed
             */
            on: function(callback) {
                return versionController.on(callback);
            },
            off: function(callback) {
                return versionController.off(callback);
            },

            // --- GitHub ---
            github: {
                /** Authenticate with a GitHub personal access token */
                authenticate: function(token) {
                    return githubManager.authenticate(token);
                },
                /** Check if authenticated */
                isAuthenticated: function() {
                    return githubManager.isAuthenticated();
                },
                /** Get authenticated user info */
                getUser: function() {
                    return githubManager.getUser();
                },
                /** Disconnect from GitHub */
                logout: function() {
                    return githubManager.logout();
                },
                /** Push to GitHub */
                push: function() {
                    var repoPath = versionController.getRepoPath();
                    if (!repoPath) return Promise.reject(new Error('No project tracked'));
                    return githubManager.push(repoPath);
                },
                /** Pull from GitHub */
                pull: function() {
                    var repoPath = versionController.getRepoPath();
                    if (!repoPath) return Promise.reject(new Error('No project tracked'));
                    return githubManager.pull(repoPath);
                },
                /** Sync (pull then push) */
                sync: function() {
                    var repoPath = versionController.getRepoPath();
                    if (!repoPath) return Promise.reject(new Error('No project tracked'));
                    return githubManager.sync(repoPath);
                },
                /** Set up GitHub remote for current project */
                setupRemote: function(projectName) {
                    var repoPath = versionController.getRepoPath();
                    if (!repoPath) return Promise.reject(new Error('No project tracked'));
                    return githubManager.getOrCreateRepo(projectName).then(function(repo) {
                        return githubManager.setupRemote(repoPath, repo.url);
                    });
                }
            },

            // --- Advanced: direct module access ---
            modules: modules
        };

        return instance;
    }

    /**
     * Mount the built-in Rewind UI into a container element.
     * Requires rewind-ui.js and rewind-ui.css to be loaded.
     *
     * @param {string} selector - CSS selector for the container element
     * @param {object} [config] - SDK config (passed to init() if not already initialized)
     * @returns {object} Rewind SDK instance
     */
    function mountUI(selector, config) {
        if (!instance) {
            init(config);
        }

        // Load UI module if not already loaded
        if (typeof RewindUI === 'undefined') {
            // Try to load from the SDK directory
            if (typeof sdkRoot !== 'undefined') {
                loadModule('ui/rewind-ui.js');
            } else {
                throw new Error(
                    'RewindUI not loaded. When using the core-only bundle, ' +
                    'include rewind-with-ui.js instead, or load rewind-ui.js separately.'
                );
            }
        }

        // Load UI styles
        var styleId = 'rewind-sdk-styles';
        if (!document.getElementById(styleId)) {
            var cssLoaded = false;
            if (typeof sdkRoot !== 'undefined') {
                var cssPath = nodePath.join(sdkRoot, 'ui', 'rewind-ui.css');
                if (fs.existsSync(cssPath)) {
                    var css = fs.readFileSync(cssPath, 'utf8');
                    var style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = css;
                    document.head.appendChild(style);
                    cssLoaded = true;
                }
            }
            if (!cssLoaded) {
                console.warn('rewind: UI styles not auto-loaded. Include rewind-ui.css manually.');
            }
        }

        var container = document.querySelector(selector);
        if (!container) {
            throw new Error('RewindSDK.mountUI: container not found: ' + selector);
        }

        RewindUI.mount(container, instance, modules);
        return instance;
    }

    /**
     * Unmount the Rewind UI.
     */
    function unmountUI() {
        if (typeof RewindUI !== 'undefined') {
            RewindUI.unmount();
        }
    }

    // --- Expose global API ---
    window.RewindSDK = {
        init: init,
        mountUI: mountUI,
        unmountUI: unmountUI,
        /** Get the current SDK instance (null if not initialized) */
        getInstance: function() { return instance; },
        /** SDK version */
        version: '1.1.0'
    };
})();


// --- UI Widget ---
// sdk/ui/rewind-ui.js - Self-contained, mountable Rewind UI widget
// Mount with: RewindUI.mount(containerElement, sdkInstance, modules)

var RewindUI = (function() {
    'use strict';

    var sdk = null;
    var mods = null;
    var rootEl = null;
    var els = {};
    var historyItems = [];
    var historyOffset = 0;
    var PAGE_SIZE = 20;
    var toastTimer = null;
    var savedTimer = null;
    var versionDropdownOpen = false;
    var pendingDeleteBranch = null;
    var pendingLabelHash = null;

    // --- HTML Template ---
    var TEMPLATE = '' +
        '<div class="rewind-root">' +
        '  <div class="rw-header">' +
        '    <div class="rw-header-left">' +
        '      <div class="rw-status-dot"></div>' +
        '      <span class="rw-header-title">Rewind</span>' +
        '    </div>' +
        '    <div class="rw-header-actions">' +
        '      <button class="rw-icon-btn rw-github-btn" title="GitHub">&#9729;</button>' +
        '      <button class="rw-icon-btn rw-settings-btn" title="Settings">&#9881;</button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-github-panel" style="display:none;">' +
        '    <div class="rw-github-setup">' +
        '      <div class="rw-icon">&#128279;</div>' +
        '      <p class="rw-github-heading">Connect to GitHub</p>' +
        '      <p class="rw-github-desc">Back up your project versions to a private GitHub repository.</p>' +
        '      <div class="rw-github-token-row">' +
        '        <input class="rw-github-token-input" type="password" placeholder="Paste your GitHub token">' +
        '        <button class="rw-snapshot-btn rw-github-connect-btn">Connect</button>' +
        '      </div>' +
        '      <p class="rw-github-help">Need a token? Go to GitHub &gt; Settings &gt; Developer settings &gt; Personal access tokens &gt; Generate new token. Select <strong>repo</strong> scope.</p>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-github-info" style="display:none;">' +
        '    <div class="rw-github-user-row">' +
        '      <img class="rw-github-avatar" src="" alt="">' +
        '      <span class="rw-github-username"></span>' +
        '      <button class="rw-sync-btn rw-github-sync-btn" title="Sync to GitHub">&#8635; Sync</button>' +
        '      <button class="rw-icon-btn rw-github-logout-btn" title="Disconnect">&#10005;</button>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-init-panel">' +
        '    <div class="rw-icon">&#128193;</div>' +
        '    <p>Stop naming your projects _FINAL_FINAL2.prproj</p>' +
        '    <p class="rw-init-subtitle">Full version history for every Premiere Pro project.</p>' +
        '    <button class="rw-init-btn">Start Tracking</button>' +
        '  </div>' +
        '  <div class="rw-main-panel" style="display:none;">' +
        '    <div class="rw-version-bar">' +
        '      <div class="rw-version-selector-wrap">' +
        '        <button class="rw-version-dropdown-btn">' +
        '          <span class="rw-current-version-name">Main Edit</span>' +
        '          <span class="rw-dropdown-arrow">&#9662;</span>' +
        '        </button>' +
        '        <div class="rw-version-dropdown" style="display:none;">' +
        '          <div class="rw-version-list"></div>' +
        '          <div class="rw-version-dropdown-divider"></div>' +
        '          <button class="rw-new-version-option">+ New Version</button>' +
        '        </div>' +
        '      </div>' +
        '      <div class="rw-version-bar-right">' +
        '        <span class="rw-project-info"></span>' +
        '        <span class="rw-status-saved"></span>' +
        '      </div>' +
        '    </div>' +
        '    <div class="rw-timeline-container">' +
        '      <div class="rw-timeline"></div>' +
        '      <div class="rw-empty-state" style="display:none;">No snapshots yet</div>' +
        '      <div class="rw-load-more" style="display:none;">' +
        '        <button class="rw-load-more-btn">Load more</button>' +
        '      </div>' +
        '    </div>' +
        '    <div class="rw-bottom-bar">' +
        '      <div class="rw-snapshot-row">' +
        '        <input class="rw-snapshot-input" type="text" placeholder="Snapshot label (optional)" maxlength="200">' +
        '        <button class="rw-snapshot-btn">Snapshot</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-settings-modal">' +
        '    <div class="rw-modal">' +
        '      <div class="rw-modal-title">Settings</div>' +
        '      <div class="rw-modal-row"><span class="rw-modal-label">Auto-save interval</span>' +
        '        <select class="rw-modal-select rw-interval-select">' +
        '          <option value="0">Off</option><option value="30">30 sec</option>' +
        '          <option value="60" selected>1 min</option><option value="120">2 min</option>' +
        '          <option value="300">5 min</option>' +
        '        </select>' +
        '      </div>' +
        '      <div class="rw-modal-row"><span class="rw-modal-label">Auto-sync to GitHub</span>' +
        '        <label class="rw-toggle"><input type="checkbox" class="rw-auto-push-toggle"><span class="rw-toggle-slider"></span></label>' +
        '      </div>' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-settings-cancel">Cancel</button>' +
        '        <button class="rw-modal-btn rw-primary rw-settings-save">Save</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-confirm-modal">' +
        '    <div class="rw-modal">' +
        '      <div class="rw-modal-title">Confirm Restore</div>' +
        '      <div class="rw-confirm-text"></div>' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-confirm-no">Cancel</button>' +
        '        <button class="rw-modal-btn rw-primary rw-confirm-yes">Restore</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-version-modal">' +
        '    <div class="rw-modal">' +
        '      <div class="rw-modal-title">New Version</div>' +
        '      <p class="rw-modal-desc">Create a copy of the current version to experiment with.</p>' +
        '      <input class="rw-modal-input rw-version-name-input" type="text" placeholder="e.g. Short Intro Alt" maxlength="60">' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-version-cancel">Cancel</button>' +
        '        <button class="rw-modal-btn rw-primary rw-version-create">Create</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-delete-version-modal">' +
        '    <div class="rw-modal">' +
        '      <div class="rw-modal-title">Delete Version</div>' +
        '      <div class="rw-confirm-text rw-delete-version-text"></div>' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-delete-version-no">Cancel</button>' +
        '        <button class="rw-modal-btn rw-primary rw-danger rw-delete-version-yes">Delete</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-diff-modal">' +
        '    <div class="rw-modal rw-modal-wide">' +
        '      <div class="rw-modal-title rw-diff-modal-title">Changes</div>' +
        '      <div class="rw-diff-content">Loading...</div>' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-diff-close">Close</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-modal-overlay rw-label-modal">' +
        '    <div class="rw-modal">' +
        '      <div class="rw-modal-title">Edit Label</div>' +
        '      <input class="rw-modal-input rw-label-edit-input" type="text" placeholder="Snapshot label" maxlength="200">' +
        '      <div class="rw-modal-actions">' +
        '        <button class="rw-modal-btn rw-secondary rw-label-cancel">Cancel</button>' +
        '        <button class="rw-modal-btn rw-primary rw-label-save">Save</button>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '  <div class="rw-toast"></div>' +
        '</div>';

    // --- Helpers ---
    function q(selector) {
        return rootEl.querySelector(selector);
    }

    function showModal(el) { el.classList.add('rw-visible'); }
    function hideModal(el) { el.classList.remove('rw-visible'); }

    function showLabelModal(hash, currentLabel) {
        pendingLabelHash = hash;
        els.labelEditInput.value = currentLabel || '';
        showModal(els.labelModal);
        setTimeout(function() { els.labelEditInput.focus(); }, 100);
    }

    function handleLabelSave() {
        var newLabel = els.labelEditInput.value;
        hideModal(els.labelModal);
        if (pendingLabelHash) {
            sdk.addLabel(pendingLabelHash, newLabel);
        }
        pendingLabelHash = null;
    }

    function showToast(msg, type) {
        clearTimeout(toastTimer);
        els.toast.textContent = msg;
        els.toast.className = 'rw-toast' + (type ? ' rw-' + type : '');
        void els.toast.offsetWidth;
        els.toast.classList.add('rw-show');
        toastTimer = setTimeout(function() { els.toast.classList.remove('rw-show'); }, 2500);
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    // --- Cache Elements ---
    function cacheElements() {
        els.statusDot = q('.rw-status-dot');
        els.initPanel = q('.rw-init-panel');
        els.mainPanel = q('.rw-main-panel');
        els.timeline = q('.rw-timeline');
        els.loadMore = q('.rw-load-more');
        els.loadMoreBtn = q('.rw-load-more-btn');
        els.emptyState = q('.rw-empty-state');
        els.snapshotInput = q('.rw-snapshot-input');
        els.snapshotBtn = q('.rw-snapshot-row .rw-snapshot-btn');
        els.initBtn = q('.rw-init-btn');
        els.projectInfo = q('.rw-project-info');
        els.settingsModal = q('.rw-settings-modal');
        els.confirmModal = q('.rw-confirm-modal');
        els.confirmText = q('.rw-confirm-text');
        els.confirmYes = q('.rw-confirm-yes');
        els.confirmNo = q('.rw-confirm-no');
        els.intervalSelect = q('.rw-interval-select');
        els.autoPushToggle = q('.rw-auto-push-toggle');
        els.settingsSave = q('.rw-settings-save');
        els.settingsCancel = q('.rw-settings-cancel');
        els.toast = q('.rw-toast');
        els.githubBtn = q('.rw-github-btn');
        els.githubPanel = q('.rw-github-panel');
        els.githubToken = q('.rw-github-token-input');
        els.githubConnectBtn = q('.rw-github-connect-btn');
        els.githubInfo = q('.rw-github-info');
        els.githubAvatar = q('.rw-github-avatar');
        els.githubUsername = q('.rw-github-username');
        els.githubSyncBtn = q('.rw-github-sync-btn');
        els.githubLogoutBtn = q('.rw-github-logout-btn');
        els.versionDropdownBtn = q('.rw-version-dropdown-btn');
        els.currentVersionName = q('.rw-current-version-name');
        els.versionDropdown = q('.rw-version-dropdown');
        els.versionList = q('.rw-version-list');
        els.newVersionBtn = q('.rw-new-version-option');
        els.statusSaved = q('.rw-status-saved');
        els.versionModal = q('.rw-version-modal');
        els.versionNameInput = q('.rw-version-name-input');
        els.versionCreate = q('.rw-version-create');
        els.versionCancel = q('.rw-version-cancel');
        els.deleteVersionModal = q('.rw-delete-version-modal');
        els.deleteVersionText = q('.rw-delete-version-text');
        els.deleteVersionYes = q('.rw-delete-version-yes');
        els.deleteVersionNo = q('.rw-delete-version-no');
        els.diffModal = q('.rw-diff-modal');
        els.diffModalTitle = q('.rw-diff-modal-title');
        els.diffContent = q('.rw-diff-content');
        els.diffClose = q('.rw-diff-close');
        els.labelModal = q('.rw-label-modal');
        els.labelEditInput = q('.rw-label-edit-input');
        els.labelSave = q('.rw-label-save');
        els.labelCancel = q('.rw-label-cancel');
    }

    // --- Bind Events ---
    function bindEvents() {
        els.initBtn.addEventListener('click', handleInit);
        els.snapshotBtn.addEventListener('click', handleSnapshot);
        els.snapshotInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleSnapshot(); });
        q('.rw-settings-btn').addEventListener('click', openSettings);
        els.settingsSave.addEventListener('click', handleSaveSettings);
        els.settingsCancel.addEventListener('click', function() { hideModal(els.settingsModal); });
        els.confirmNo.addEventListener('click', function() { hideModal(els.confirmModal); });
        els.loadMoreBtn.addEventListener('click', loadMoreHistory);

        els.githubBtn.addEventListener('click', toggleGitHubPanel);
        els.githubConnectBtn.addEventListener('click', handleGitHubConnect);
        els.githubToken.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleGitHubConnect(); });
        els.githubSyncBtn.addEventListener('click', handleGitHubSync);
        els.githubLogoutBtn.addEventListener('click', handleGitHubLogout);

        els.versionDropdownBtn.addEventListener('click', toggleVersionDropdown);
        els.newVersionBtn.addEventListener('click', openNewVersionModal);
        els.versionCreate.addEventListener('click', handleCreateVersion);
        els.versionCancel.addEventListener('click', function() { hideModal(els.versionModal); });
        els.versionNameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') handleCreateVersion(); });

        els.deleteVersionNo.addEventListener('click', function() { hideModal(els.deleteVersionModal); });
        els.deleteVersionYes.addEventListener('click', handleDeleteVersion);
        els.diffClose.addEventListener('click', function() { hideModal(els.diffModal); });

        els.labelCancel.addEventListener('click', function() { hideModal(els.labelModal); });
        els.labelSave.addEventListener('click', handleLabelSave);
        els.labelEditInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') handleLabelSave();
            if (e.key === 'Escape') hideModal(els.labelModal);
        });

        var modals = [els.settingsModal, els.confirmModal, els.versionModal, els.deleteVersionModal, els.diffModal, els.labelModal];
        modals.forEach(function(modal) {
            modal.addEventListener('click', function(e) { if (e.target === modal) hideModal(modal); });
        });

        document.addEventListener('click', function(e) {
            if (versionDropdownOpen && !els.versionDropdownBtn.contains(e.target) && !els.versionDropdown.contains(e.target)) {
                closeVersionDropdown();
            }
        });
    }

    // --- Listen to SDK events ---
    var sdkListener = null;

    function listenToSDK() {
        sdkListener = function(event, data) {
            switch (event) {
                case 'initialized':
                    showMainPanel();
                    setStatus('active');
                    showProjectPath(data.projectPath);
                    updateVersionName(data.version || 'Main Edit');
                    refreshHistory();
                    showToast('Tracking initialized', 'success');
                    if (sdk.github.isAuthenticated()) setupGitHubRemote();
                    break;
                case 'snapshot':
                case 'auto-snapshot':
                    refreshHistory();
                    updateSavedTime();
                    if (event === 'auto-snapshot') showToast('Auto-snapshot saved');
                    break;
                case 'restored':
                    refreshHistory();
                    updateSavedTime();
                    showToast('Restored to ' + data.hash.substring(0, 7), 'success');
                    break;
                case 'busy':
                    setStatus(data ? 'busy' : 'active');
                    els.snapshotBtn.disabled = !!data;
                    break;
                case 'project-closed':
                    var st = sdk.getState();
                    if (!st.initialized) { showInitPanel(); setStatus('inactive'); els.projectInfo.textContent = ''; }
                    break;
                case 'project-switched':
                    showToast('Project switched, re-initializing...');
                    break;
                case 'version-created':
                    updateVersionName(data.displayName);
                    refreshHistory();
                    showToast('Version "' + data.displayName + '" created', 'success');
                    break;
                case 'version-switched':
                    updateVersionName(data.displayName);
                    refreshHistory();
                    updateSavedTime();
                    showToast('Switched to "' + data.displayName + '"', 'success');
                    break;
                case 'version-deleted':
                    showToast('Version deleted');
                    break;
                case 'labels-changed':
                    refreshHistory();
                    break;
            }
        };
        sdk.on(sdkListener);
    }

    // --- Core Actions ---
    function handleInit() {
        els.initBtn.disabled = true;
        els.initBtn.textContent = 'Initializing...';
        setStatus('busy');
        sdk.start().catch(function(err) {
            showToast('Init failed: ' + err.message, 'error');
            setStatus('inactive');
            els.initBtn.disabled = false;
            els.initBtn.textContent = 'Start Tracking';
        });
    }

    function handleSnapshot() {
        var msg = els.snapshotInput.value.trim();
        var label = msg;
        els.snapshotBtn.disabled = true;
        sdk.snapshot(msg || undefined).then(function(committed) {
            els.snapshotInput.value = '';
            if (committed) {
                if (label) {
                    sdk.getHistory(1).then(function(commits) {
                        if (commits.length > 0) sdk.addLabel(commits[0].hash, label);
                    });
                }
                showToast('Snapshot saved', 'success');
            } else {
                showToast('No changes detected');
            }
        }).catch(function(err) {
            showToast('Snapshot failed: ' + err.message, 'error');
        }).then(function(result) {
            els.snapshotBtn.disabled = false;
            return result;
        }, function(err) {
            els.snapshotBtn.disabled = false;
            throw err;
        });
    }

    function handleRestore(commitHash) {
        els.confirmText.textContent = 'Current state will be saved first. Restore to this snapshot?';
        showModal(els.confirmModal);
        var confirmHandler, cancelHandler;
        function cleanup() {
            els.confirmYes.removeEventListener('click', confirmHandler);
            els.confirmNo.removeEventListener('click', cancelHandler);
        }
        confirmHandler = function() {
            cleanup(); hideModal(els.confirmModal);
            sdk.restore(commitHash).catch(function(err) {
                showToast('Restore failed: ' + err.message, 'error');
            });
        };
        cancelHandler = function() { cleanup(); hideModal(els.confirmModal); };
        els.confirmYes.addEventListener('click', confirmHandler);
        els.confirmNo.addEventListener('click', cancelHandler);
    }

    // --- Version Management ---
    function toggleVersionDropdown() {
        versionDropdownOpen ? closeVersionDropdown() : openVersionDropdown();
    }

    function openVersionDropdown() {
        sdk.listVersions().then(function(versions) {
            els.versionList.innerHTML = '';
            versions.forEach(function(v) {
                var opt = document.createElement('div');
                opt.className = 'rw-version-option' + (v.current ? ' rw-active' : '');
                var nameSpan = document.createElement('span');
                nameSpan.className = 'rw-version-option-name';
                nameSpan.textContent = v.displayName;
                opt.appendChild(nameSpan);
                if (!v.current && v.branch !== 'master') {
                    var delBtn = document.createElement('button');
                    delBtn.className = 'rw-version-delete-btn';
                    delBtn.innerHTML = '&#10005;';
                    delBtn.title = 'Delete version';
                    delBtn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        closeVersionDropdown();
                        confirmDeleteVersion(v.branch, v.displayName);
                    });
                    opt.appendChild(delBtn);
                }
                if (!v.current) {
                    opt.addEventListener('click', function() {
                        closeVersionDropdown();
                        sdk.switchVersion(v.branch).catch(function(err) {
                            showToast('Switch failed: ' + err.message, 'error');
                        });
                    });
                }
                els.versionList.appendChild(opt);
            });
            els.versionDropdown.style.display = 'block';
            versionDropdownOpen = true;
        });
    }

    function closeVersionDropdown() {
        els.versionDropdown.style.display = 'none';
        versionDropdownOpen = false;
    }

    function openNewVersionModal() {
        closeVersionDropdown();
        els.versionNameInput.value = '';
        showModal(els.versionModal);
        setTimeout(function() { els.versionNameInput.focus(); }, 100);
    }

    function handleCreateVersion() {
        var name = els.versionNameInput.value.trim();
        if (!name) { showToast('Please enter a version name', 'error'); return; }
        hideModal(els.versionModal);
        sdk.createVersion(name).catch(function(err) {
            showToast('Create failed: ' + err.message, 'error');
        });
    }

    function confirmDeleteVersion(branch, displayName) {
        pendingDeleteBranch = branch;
        els.deleteVersionText.textContent = 'Delete "' + displayName + '"? This will permanently remove this version and all its snapshots.';
        showModal(els.deleteVersionModal);
    }

    function handleDeleteVersion() {
        hideModal(els.deleteVersionModal);
        if (!pendingDeleteBranch) return;
        var branch = pendingDeleteBranch;
        pendingDeleteBranch = null;
        sdk.deleteVersion(branch).catch(function(err) {
            showToast('Delete failed: ' + err.message, 'error');
        });
    }

    function updateVersionName(name) {
        els.currentVersionName.textContent = name || 'Main Edit';
    }

    // --- History ---
    function refreshHistory() {
        historyOffset = 0;
        sdk.getHistory(PAGE_SIZE + 1).then(function(commits) {
            historyItems = commits;
            renderTimeline(commits.slice(0, PAGE_SIZE));
            els.loadMore.style.display = commits.length > PAGE_SIZE ? 'block' : 'none';
        }).catch(function() {});
    }

    function loadMoreHistory() {
        historyOffset += PAGE_SIZE;
        sdk.getHistory(historyOffset + PAGE_SIZE + 1).then(function(commits) {
            historyItems = commits;
            renderTimeline(commits.slice(0, historyOffset + PAGE_SIZE));
            els.loadMore.style.display = commits.length > historyOffset + PAGE_SIZE ? 'block' : 'none';
        }).catch(function() {});
    }

    function renderTimeline(commits) {
        var labels = sdk.getLabels();
        els.timeline.innerHTML = '';
        if (commits.length === 0) { els.emptyState.style.display = 'block'; return; }
        els.emptyState.style.display = 'none';

        commits.forEach(function(commit, i) {
            var item = document.createElement('div');
            item.className = 'rw-commit-item';

            var dotCol = document.createElement('div');
            dotCol.className = 'rw-commit-dot-col';
            var dot = document.createElement('div');
            dot.className = 'rw-commit-dot';
            dotCol.appendChild(dot);
            if (i < commits.length - 1) {
                var line = document.createElement('div');
                line.className = 'rw-commit-line';
                dotCol.appendChild(line);
            }

            var info = document.createElement('div');
            info.className = 'rw-commit-info';

            var msg = document.createElement('div');
            msg.className = 'rw-commit-message';
            msg.textContent = commit.message;
            msg.title = commit.message;
            info.appendChild(msg);

            var label = labels[commit.hash];
            var labelEl = document.createElement('span');
            labelEl.className = 'rw-commit-label' + (label ? '' : ' rw-empty');
            labelEl.textContent = label || '+ label';
            labelEl.title = label ? 'Click to edit label' : 'Click to add label';
            labelEl.addEventListener('click', (function(hash, currentLabel) {
                return function() {
                    showLabelModal(hash, currentLabel);
                };
            })(commit.hash, label));
            info.appendChild(labelEl);

            var meta = document.createElement('div');
            meta.className = 'rw-commit-meta';
            var hashSpan = document.createElement('span');
            hashSpan.className = 'rw-commit-hash';
            hashSpan.textContent = commit.hash.substring(0, 7);
            meta.appendChild(hashSpan);
            meta.appendChild(document.createTextNode(' \u00B7 ' + commit.dateRelative));

            if (i < commits.length - 1) {
                var diffLink = document.createElement('span');
                diffLink.className = 'rw-commit-diff-link';
                diffLink.textContent = 'diff';
                diffLink.addEventListener('click', (function(hashNew, hashOld) {
                    return function() { showDiff(hashNew, hashOld); };
                })(commit.hash, commits[i + 1].hash));
                meta.appendChild(document.createTextNode(' \u00B7 '));
                meta.appendChild(diffLink);
            }
            info.appendChild(meta);

            var actions = document.createElement('div');
            actions.className = 'rw-commit-actions';
            if (i > 0) {
                var btn = document.createElement('button');
                btn.className = 'rw-restore-btn';
                btn.textContent = 'Restore';
                btn.addEventListener('click', (function(hash) {
                    return function() { handleRestore(hash); };
                })(commit.hash));
                actions.appendChild(btn);
            }

            item.appendChild(dotCol);
            item.appendChild(info);
            item.appendChild(actions);
            els.timeline.appendChild(item);
        });
    }

    // --- Diffs ---
    function showDiff(hashNew, hashOld) {
        els.diffContent.textContent = 'Comparing...';
        els.diffModalTitle.textContent = 'Changes';
        showModal(els.diffModal);
        sdk.getDiff(hashOld, hashNew).then(function(result) {
            if (!result || result.totalChanges === 0) {
                els.diffContent.innerHTML = '<div class="rw-diff-summary-text">No meaningful changes detected</div>';
                return;
            }
            var html = '';
            if (result.sequences && result.sequences.length > 0) {
                result.sequences.forEach(function(s) {
                    var cssClass = s.status === 'added' ? 'rw-added' : s.status === 'removed' ? 'rw-removed' : 'rw-modified';
                    var desc = s.status === 'added' ? 'Added' : s.status === 'removed' ? 'Removed' : s.changes + ' changes';
                    html += '<div class="rw-diff-item ' + cssClass + '"><strong>' + escapeHtml(s.name) + '</strong>: ' + desc + '</div>';
                });
            }
            if (result.projectSettings && result.projectSettings.changed) {
                html += '<div class="rw-diff-item rw-modified">' + result.projectSettings.count + ' project setting changes</div>';
            }
            if (!html) html = '<div class="rw-diff-summary-text">' + escapeHtml(result.summary) + '</div>';
            els.diffContent.innerHTML = html;
        }).catch(function(err) {
            els.diffContent.textContent = 'Diff failed: ' + err.message;
        });
    }

    // --- GitHub ---
    function checkGitHub() {
        if (sdk.github.isAuthenticated()) showGitHubConnected();
    }

    function toggleGitHubPanel() {
        if (sdk.github.isAuthenticated()) {
            var vis = els.githubInfo.style.display;
            els.githubInfo.style.display = vis === 'none' ? 'block' : 'none';
            els.githubPanel.style.display = 'none';
        } else {
            var vis2 = els.githubPanel.style.display;
            els.githubPanel.style.display = vis2 === 'none' ? 'block' : 'none';
        }
    }

    function handleGitHubConnect() {
        var token = els.githubToken.value.trim();
        if (!token) { showToast('Please paste a GitHub token', 'error'); return; }
        els.githubConnectBtn.disabled = true;
        els.githubConnectBtn.textContent = 'Connecting...';
        sdk.github.authenticate(token).then(function(user) {
            showToast('Connected as ' + user.login, 'success');
            showGitHubConnected();
            els.githubPanel.style.display = 'none';
            els.githubToken.value = '';
            var st = sdk.getState();
            if (st.initialized) setupGitHubRemote();
        }).catch(function(err) {
            showToast('GitHub auth failed: ' + err.message, 'error');
        }).then(function(result) {
            els.githubConnectBtn.disabled = false;
            els.githubConnectBtn.textContent = 'Connect';
            return result;
        }, function(err) {
            els.githubConnectBtn.disabled = false;
            els.githubConnectBtn.textContent = 'Connect';
            throw err;
        });
    }

    function showGitHubConnected() {
        var user = sdk.github.getUser();
        if (!user) return;
        els.githubAvatar.src = user.avatar || '';
        els.githubAvatar.style.display = user.avatar ? 'block' : 'none';
        els.githubUsername.textContent = user.login || user.name;
        els.githubInfo.style.display = 'block';
        els.githubPanel.style.display = 'none';
    }

    function setupGitHubRemote() {
        var st = sdk.getState();
        if (!st.projectPath) return Promise.resolve();
        var projectName = st.projectPath.replace(/\\/g, '/').split('/').pop();
        return sdk.github.setupRemote(projectName).catch(function() {});
    }

    function handleGitHubSync() {
        els.githubSyncBtn.disabled = true;
        els.githubSyncBtn.textContent = 'Syncing...';
        if (!sdk.getRepoPath()) {
            showToast('No project being tracked', 'error');
            els.githubSyncBtn.disabled = false;
            els.githubSyncBtn.textContent = '\u21BB Sync';
            return;
        }
        setupGitHubRemote().then(function() {
            return sdk.github.sync();
        }).then(function() {
            showToast('Synced to GitHub', 'success');
        }).catch(function(err) {
            showToast('Sync failed: ' + err.message, 'error');
        }).then(function(result) {
            els.githubSyncBtn.disabled = false;
            els.githubSyncBtn.textContent = '\u21BB Sync';
            return result;
        }, function(err) {
            els.githubSyncBtn.disabled = false;
            els.githubSyncBtn.textContent = '\u21BB Sync';
            throw err;
        });
    }

    function handleGitHubLogout() {
        sdk.github.logout();
        els.githubInfo.style.display = 'none';
        els.githubAvatar.src = '';
        els.githubUsername.textContent = '';
        showToast('Disconnected from GitHub');
    }

    // --- Settings ---
    function openSettings() {
        var s = sdk.getSettings();
        els.intervalSelect.value = String(s.autoSaveIntervalSeconds);
        els.autoPushToggle.checked = !!s.autoPush;
        showModal(els.settingsModal);
    }

    function handleSaveSettings() {
        sdk.saveSettings({
            autoSaveIntervalSeconds: parseInt(els.intervalSelect.value, 10),
            autoPush: els.autoPushToggle.checked
        });
        hideModal(els.settingsModal);
        showToast('Settings saved', 'success');
    }

    // --- UI Helpers ---
    function showMainPanel() {
        els.initPanel.style.display = 'none';
        els.mainPanel.style.display = 'flex';
    }

    function showInitPanel() {
        els.initPanel.style.display = 'flex';
        els.mainPanel.style.display = 'none';
        els.initBtn.disabled = false;
        els.initBtn.textContent = 'Start Tracking';
    }

    function setStatus(status) {
        els.statusDot.className = 'rw-status-dot' + (status !== 'inactive' ? ' rw-' + status : '');
    }

    function showProjectPath(p) {
        if (!p) return;
        var name = p.replace(/\\/g, '/').split('/').pop();
        els.projectInfo.textContent = name;
        els.projectInfo.title = p;
    }

    function updateSavedTime() {
        if (savedTimer) clearInterval(savedTimer);
        var savedAt = new Date();
        function update() {
            var diff = Math.floor((Date.now() - savedAt.getTime()) / 1000);
            if (diff < 5) els.statusSaved.textContent = 'saved just now';
            else if (diff < 60) els.statusSaved.textContent = 'saved ' + diff + 's ago';
            else if (diff < 3600) els.statusSaved.textContent = 'saved ' + Math.floor(diff / 60) + 'm ago';
            else els.statusSaved.textContent = 'saved ' + Math.floor(diff / 3600) + 'h ago';
        }
        update();
        savedTimer = setInterval(update, 10000);
    }

    function checkProject() {
        mods.Bridge.callHost('getProjectPath').then(function(projectPath) {
            if (projectPath) {
                var nodePath = cep_node.require('path');
                var nodeFs = cep_node.require('fs');
                var dir = nodePath.dirname(nodePath.normalize(projectPath));
                if (nodeFs.existsSync(nodePath.join(dir, '.rewind')) || nodeFs.existsSync(nodePath.join(dir, '.ppgit'))) {
                    handleInit();
                    return;
                }
                showInitPanel();
                showProjectPath(projectPath);
            } else {
                showInitPanel();
            }
        }).catch(function() {
            showInitPanel();
        });
    }

    // --- Public API ---
    function mount(container, sdkInstance, modules) {
        sdk = sdkInstance;
        mods = modules;
        container.innerHTML = TEMPLATE;
        rootEl = container.querySelector('.rewind-root');
        cacheElements();
        bindEvents();
        listenToSDK();
        checkGitHub();
        checkProject();
    }

    function unmount() {
        if (savedTimer) clearInterval(savedTimer);
        if (toastTimer) clearTimeout(toastTimer);
        if (sdkListener && sdk) {
            sdk.off(sdkListener);
            sdkListener = null;
        }
        if (rootEl && rootEl.parentNode) {
            rootEl.parentNode.removeChild(rootEl);
        }
        rootEl = null;
        els = {};
        sdk = null;
        mods = null;
    }

    return {
        mount: mount,
        unmount: unmount
    };
})();
