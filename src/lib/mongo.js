/* eslint require-atomic-updates: 0 */
"use strict";

const fs = require("fs");
const { promisify } = require("util");

const MongoClient = require("mongodb").MongoClient;

const config = require("./config");

const localhost = "127.0.0.1"; // Can access mongo as localhost from a sidecar

let certificates = null;

const getConnectionURI = (host) => {
    let credentials = "";
    if (config.mongoUsername) {
        const username = encodeURIComponent(config.mongoUsername);
        const password = encodeURIComponent(config.mongoPassword);
        credentials = `${username}:${password}@`;
    }

    return `mongodb://${credentials}${host}:${config.mongoPort}/${config.mongoDatabase}`;
};

const getTLSCertificates = async () => {
    const readFile = promisify(fs.readFile);

    try {
        let tasks = [];
        if (config.mongoTLSCert) tasks[0] = readFile(config.mongoTLSCert);
        if (config.mongoTLSKey) tasks[1] = readFile(config.mongoTLSKey);
        if (config.mongoTLSCA) tasks[2] = readFile(config.mongoTLSCA);
        if (config.mongoTLSCRL) tasks[3] = readFile(config.mongoTLSCRL);

        const files = await Promise.all(tasks);

        let certs = {};
        if (files[0]) certs.sslCert = files[0];
        if (files[1]) certs.sslKey = files[1];
        if (files[2]) certs.sslCA = files[2];
        if (files[3]) certs.sslCRL = files[3];
        return certs;
    } catch (err) {
        return Promise.reject(err);
    }
};

const getClient = async (host) => {
    host = host || localhost;
    let options = {
        authSource: config.mongoAuthSource,
        authMechanism: config.mongoUsername ? config.authMechanism : "",
        ssl: config.mongoTLS,
        sslPass: config.mongoTLSPassword,
        checkServerIdentity: config.mongoTLSServerIdentityCheck,
        useNewUrlParser: true,
    };

    try {
        if (config.mongoTLS) {
            certificates = certificates || (await getTLSCertificates());
            Object.assign(options, certificates);
        }
        const uri = getConnectionURI(host);
        const client = new MongoClient(uri, options);
        return client.connect();
    } catch (err) {
        return Promise.reject(err);
    }
};

const replSetGetConfig = (db) =>
    db
        .admin()
        .command({ replSetGetConfig: 1 }, {})
        .then((results) => results.config);

const replSetGetStatus = (db) =>
    db.admin().command({ replSetGetStatus: {} }, {});

const initReplSet = async (db, hostIpAndPort) => {
    console.info("initReplSet", hostIpAndPort);

    try {
        await db.admin().command({ replSetInitiate: {} }, {});

        // We need to hack in the fix where the host is set to the hostname which isn't reachable from other hosts
        const rsConfig = await replSetGetConfig(db);

        console.info("initial rsConfig is", rsConfig);
        rsConfig.configsvr = config.isConfigRS;
        rsConfig.members[0].host = hostIpAndPort;

        const times = 20;
        const interval = 500;
        const wait = (time) =>
            new Promise((resolve) => setTimeout(resolve, time));

        let tries = 0;
        while (tries < times) {
            try {
                return await replSetReconfig(db, rsConfig, false);
            } catch (err) {
                await wait(interval);
                tries++;
                if (tries >= times) return Promise.reject(err);
            }
        }
    } catch (err) {
        return Promise.reject(err);
    }
};

const replSetReconfig = (db, rsConfig, force) => {
    console.info("replSetReconfig", rsConfig);

    rsConfig.version++;

    return db.admin().command({ replSetReconfig: rsConfig, force: force }, {});
};

const addNewReplSetMembers = async (
    db,
    addrToAdd,
    addrToRemove,
    shouldForce
) => {
    try {
        let rsConfig = await replSetGetConfig(db);
        const limit = shouldForce ? 50 : 1;
        const removed = removeDeadMembers(rsConfig, addrToRemove, limit);
        if (shouldForce || !removed) addNewMembers(rsConfig, addrToAdd, limit);
        return replSetReconfig(db, rsConfig, shouldForce);
    } catch (err) {
        return Promise.reject(err);
    }
};

const addNewMembers = (rsConfig, addrsToAdd, limit) => {
    if (!addrsToAdd || !addrsToAdd.length) return;

    // Follows what is basically in mongo's rs.add function
    let max = 0;

    for (const member of rsConfig.members) {
        if (member._id > max) {
            max = member._id;
        }
    }

    let added = 0;

    for (const addr of addrsToAdd) {
        if (added === limit) return;

        // Somehow we can get a race condition where the member config has been updated since we created the list of
        // addresses to add (addrsToAdd) ... so do another loop to make sure we're not adding duplicates
        let exists = false;
        for (const member of rsConfig.members) {
            if (member.host === addr) {
                console.info(
                    "Host [%s] already exists in the Replicaset. Not adding...",
                    addr
                );
                exists = true;
                break;
            }
        }

        if (exists) continue;

        const cfg = {
            _id: ++max,
            host: addr,
        };

        rsConfig.members.push(cfg);
        added++;
    }

    return added;
};

const removeDeadMembers = (rsConfig, addrsToRemove, limit) => {
    if (!addrsToRemove || !addrsToRemove.length) return;

    let removed = 0;

    for (const addr of addrsToRemove) {
        if (removed === limit) return;
        for (const i in rsConfig.members) {
            if (rsConfig.members[i].host === addr) {
                rsConfig.members.splice(i, 1);
                removed++;
                break;
            }
        }
    }

    return removed;
};

const isInReplSet = async (ip) => {
    let client;
    try {
        client = await getClient(ip);
    } catch (err) {
        return Promise.reject(err);
    }

    try {
        await replSetGetConfig(client.db(config.mongoDatabase));
        return true;
    } catch (err) {
        return false;
    } finally {
        client.close();
    }
};

module.exports = {
    getClient,
    replSetGetStatus,
    initReplSet,
    addNewReplSetMembers,
    isInReplSet,
};
