import http from 'node:http'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import Aria2 from 'aria2'
import axios from 'axios'
import * as cheerio from 'cheerio'
import express from 'express'
import {Low} from 'lowdb'
import {JSONFile} from 'lowdb/node'
import {Server} from 'socket.io'


const app = express();
const server = http.createServer(app);
const io = new Server(server);

const __dirname = dirname(fileURLToPath(import.meta.url));

const file = join(__dirname, 'database/db.json');
const adapter = new JSONFile(file);
const defaultData = {bangumiList: []};
const db = new Low(adapter, defaultData);
await db.read();

const aria2 = new Aria2({
    host: process.env.ARIA2_HOST || "127.0.0.1",
    port: process.env.ARIA2_PORT || "6800",
    secure: process.env.ARIA2_SECURE !== undefined,
    secret: process.env.ARIA2_SECRET || '',
    path: process.env.ARIA2_RPC_PATH || '/jsonrpc'
});


const episodeKeyRegex = /show-(.+)\.html/;
const hashRegex = /Config\['hash_id'\]\s*=\s*"([^"]+)"/;
const announceRegex = /Config\['announce'\]\s*=\s*"([^"]+)"/;

const buildSearchUrl = (keyword, page) => {
    return "https://www.kisssub.org/search.php?keyword=" + encodeURIComponent(keyword) + "&page=" + page;
};

const buildEpisodeUrl = (key) => {
    return "https://www.kisssub.org/show-" + key + ".html";
};

const buildMagnet = (hash, announce) => {
    return "magnet:?xt=urn:btih:" + hash + "&tr=" + announce;
};

const buildPath = (path) => {
    return join(process.env.ARIA2_DOWNLOAD_PATH || "/downloads", path);
};

const updateBangumiInfo = async (id) => {
    for (const i in db.data.bangumiList) {
        if (id !== undefined && i !== id) continue;
        const bangumi = db.data.bangumiList[i];

        let page = 1;
        try {
            while (true) {
                const searchUrl = buildSearchUrl(bangumi.keyword, page);
                const searchResponse = await axios.get(searchUrl);
                const $ = cheerio.load(searchResponse.data);

                const currentPage = $("span.current");
                if (currentPage.length !== 0) {
                    if (parseInt($(currentPage[0]).text().trim()) !== page) {
                        // More than last page
                        break;
                    }
                }

                $("#data_list").children("tr").each((index, row) => {
                    $(row).find("td:eq(2)").each((index, col) => {
                        const title = $(col).text().trim();
                        const key = $($(col).children("a")[0]).attr("href").match(episodeKeyRegex)[1].trim();
                        if (!(key in bangumi.searchResults)) {
                            bangumi.searchResults[key] = {
                                "title": title,
                                "status": "ready"
                            };
                        }
                    });
                });

                if (currentPage.length === 0) {
                    // Only one page
                    break;
                }
                page++;
            }
        } catch (error) {
            console.warn(error);
        }
    }

    await db.write();
    io.emit("bangumiList", db.data.bangumiList);
}

let downloadEpisodesWorking = false;
const downloadEpisodes = async () => {
    if (downloadEpisodesWorking) return;
    downloadEpisodesWorking = true;

    for (const i in db.data.bangumiList) {
        const bangumi = db.data.bangumiList[i];
        for (const key in bangumi.searchResults) {
            const result = bangumi.searchResults[key];
            try {
                if (result.status === "ready") {

                    const episodeUrl = buildEpisodeUrl(key);
                    const episodeResponse = await axios.get(episodeUrl);
                    const hash = episodeResponse.data.match(hashRegex)[1];
                    const announce = episodeResponse.data.match(announceRegex)[1];
                    const magnet = buildMagnet(hash, announce);

                    const gid = await aria2.call("addUri", [magnet], {dir: buildPath(bangumi.path)});
                    result.ariaGid = gid;
                    result.status = "downloading";
                } else if (result.status === "downloading") {
                    const response = await aria2.call("tellStatus", result.ariaGid, ["status"]);
                    if (response.status === "complete") {
                        result.status = "downloaded";
                    } else if (response.status === "removed" || response.status === "error") {
                        result.status = "error";
                    }
                }
            } catch (error) {
                console.warn(error);
            }
        }
    }

    await db.write();
    io.emit("bangumiList", db.data.bangumiList);

    downloadEpisodesWorking = false;
};


app.get("/", (req, res) => {
    res.sendFile("./index.html", {root: __dirname});
});

app.get("/bangumi/:id", (req, res) => {
    res.sendFile("./bangumi.html", {root: __dirname});
});

app.get("/socket.io.min.js", (req, res) => {
    res.sendFile("./socket.io.min.js", {root: __dirname});
});

app.get("/style.css", (req, res) => {
    res.sendFile("./style.css", {root: __dirname});
});


io.on("connection", async (socket) => {
    socket.emit("bangumiList", db.data.bangumiList);

    socket.on("addBangumi", async (name, keyword, path) => {
        const len = db.data.bangumiList.push({
            name: name,
            keyword: keyword,
            path: path,
            searchResults: {},
        });
        await db.write();
        io.emit("bangumiList", db.data.bangumiList);

        await updateBangumiInfo(len - 1);
        io.emit("bangumiList", db.data.bangumiList);

        await downloadEpisodes();
        io.emit("bangumiList", db.data.bangumiList);
    });
});


setInterval(updateBangumiInfo, 60000);
setInterval(downloadEpisodes, 5000);

server.listen("80");