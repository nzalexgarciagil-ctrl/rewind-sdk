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
