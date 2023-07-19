const app = require('express')();
const { uuid } = require('uuidv4');
const cors = require('cors');
const bodyParser = require('body-parser');
const validator = require('is-my-json-valid')
const multer = require('multer')();
const FormData = require('form-data');
const axios = require('axios');
const https = require('https');
const server = require('http').createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });
const validateJson = require("./validate.json")
const { Pool } = require('postgres-pool')

server.listen(process.env.PORT || 3098);
app.use(cors({ exposedHeaders: ["Link"] }));
app.use(bodyParser.urlencoded({ extended: true, }));
app.use(bodyParser.json({ limit: "50MB" }));
const agent = new https.Agent({ rejectUnauthorized: false });

// view engine setup
app.set('views', __dirname);
app.set('view engine', 'ejs');

var pool = null

if (!!process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    createTable()
}

const cors_proxy = require('cors-anywhere').createServer({
    originWhitelist: [],
    requireHeader: [],
    removeHeaders: []
})

io.on("connection", (socket) => {

    socket.on('join', function (roomId) {
        (roomId || []).forEach(ele => socket.join(`${ele}`));
        retrivePendingWebhook(roomId)
    });

    socket.on('retrive_webhook_queue', retrivePendingWebhook);

    socket.on('request_qr', (data) => {
        console.log("request_qr 1 ------>  ", data);
        io.to(data).emit("request_qr_get", { data, id: 1 })
    });

    socket.on('request_qr', function (data) {
        console.log("request_qr 2 ------>  ", data);
        io.to(data).emit("request_qr_get", { data, id: 2 })
    });

    socket.on('webhook_status_update', async function (data) {
        let specificAllData = await getMissedWebhookBySocekt(data.socketId);
        let specificData = (specificAllData || []).map(ele => { return { ...ele.mw_data, createdDate: ele.mw_created_at } })
        let index = specificData.findIndex(ele => ele.inner_ref_id === data.inner_ref_id)
        if (index >= 0 && specificData[index]) {
            await deleteMissedWebhookBySocekt(specificAllData[index].mw_id)
            specificData.splice(index, 1)
            io.to(data.socketId).emit("webhook_queue", specificData)
        }
    });

    socket.on('disconnect', function () {
        socket.leave(`${socket.id}`)
    });

    async function retrivePendingWebhook(roomId) {
        let allPendingQueue = [];
        for (let i = 0; i < (roomId || []).length; i++) {
            let res = await getMissedWebhookBySocekt(roomId[i]);
            res = (res || []).map(ele => { return { ...ele.mw_data, createdDate: ele.mw_created_at } })
            allPendingQueue = allPendingQueue.concat(res)
        }
        io.to(socket.id).emit("webhook_queue", allPendingQueue)
    }
});

function isSocketConnected(req) {
    let socketId = `${req.params.mo_no}$$$${req.params.unique_id}`;
    try {
        let roomIds = Array.from(io.sockets?.adapter?.rooms || [])
        let userRoomId = roomIds.filter(room => !room[1].has(room[0])).find(ele => ele[0] === socketId)
        if (!!userRoomId) {
            let roomSocketIds = Array.from(userRoomId[1])
            if (roomSocketIds.length > 0) {
                return roomSocketIds[0]
            } else {
                return null
            }
        } else {
            return null
        }
    } catch (error) {
        return null
    }
}

function sendDataToSocekt(req, isValid, response, status) {
    let socketId = `${req.params.mo_no}$$$${req.params.unique_id}`;
    let sendData = { socketId, error: !isValid, from: atob(req.params.mo_no), uniqueId: req.params.unique_id, url: `${req.protocol ? (req.protocol + "://" + req.get('host')) : ''}${req.originalUrl}`, request: req.body, response, status, inner_ref_id: uuid() }
    let roomId = isSocketConnected(req)
    if (!!roomId) {
        io.to(roomId).emit("webhook_received", sendData)
    } else {
        addDataInWebhookQueue(sendData)
    }
}

async function checkHeader(req, res, next) {
    if (!pool) {
        res.status(401).json({ status: 401, error: 'Please configure database. Learn more at https://links.google.com/err-config-database' });
        return
    }

    let apiKey = req.headers && (req.headers['X-API-KEY'] || req.headers['x-api-key'])
    if (!apiKey) {
        res.status(401).json({ status: 401, error: 'X-API-KEY header is missing. Learn more at https://links.google.com/err-header-is-missing' });
        return
    }

    let response = await checkIsKeyAdded(apiKey);
    if (response && response.length > 0) {
        next()
    } else {
        res.status(401).json({ status: 401, error: 'Unauthorized access. Learn more at https://links.google.com/err-unauthorized-access' });
    }
}

async function checkHeaderChatwoot(req, res, next) {
    if (!pool) {
        res.status(401).json({ status: 401, error: 'Please configure database. Learn more at https://links.google.com/err-config-database' });
        return
    }
    next()
}

app.post('/api/v1/webhook/external/call', async (req, res) => {
    try {
        let response = await axios({ method: req.body.method, url: req.body.url, data: req.body.data, headers: { 'Content-Type': 'application/json', ...(req.body.header || {}) }, httpsAgent: agent })
        res.status(response.status || 200).json(response.data);
    } catch (error) {
        res.status(404).json({ message: error.message });
    }
});

app.post('/api/v1/webhook/external/chatwoot/message', multer.single('file'), async (req, res) => {
    try {
        let form = new FormData();
        form.append('content', req.body.content);
        let contentType = 'multipart/form-data;'
        if (req.file) {
            const fileRecievedFromClient = req.file;
            form.append('attachments[]', fileRecievedFromClient.buffer, fileRecievedFromClient.originalname);
            contentType = `multipart/form-data; boundary=${form._boundary}`
        }
        let response = await axios.post(req.body.url, form, {
            headers: { 'Content-Type': contentType },
            httpsAgent: agent
        });
        res.status(response.status || 200).json(response.data);
    } catch (error) {
        res.status(404).json({ message: error.message });
    }
});

app.post('/api/v1/webhook/chatwoot/:mo_no/:unique_id', checkHeaderChatwoot, (req, res) => {
    try {
        let status = 200
        let successJson = { status }
        if (req.body.message_type === 'outgoing' && !req.body.private) {
            sendDataToSocekt(req, true, successJson, status)
        }
        res.status(status).json(successJson);
    } catch (error) {
        let errJson = { status: 500, error: error.message }
        if (req.body.message_type === 'outgoing') {
            sendDataToSocekt(req, false, errJson, 500)
        }
        res.status(500).json(errJson);
    }
});

app.get('/api/v1/webhook/:mo_no/:unique_id/zapier', checkHeader, (req, res) => {
    try {
        res.status(200).json({ status: 200 });
    } catch (error) {
        res.status(500).json({ status: 500 });
    }
});

app.delete('/api/v1/webhook/:mo_no/:unique_id/zapier/unsubscribe', checkHeader, (req, res) => {
    try {
        res.status(200).json({ status: 200 });
    } catch (error) {
        res.status(500).json({ status: 500 });
    }
});

app.use((err, req, res, next) => {
    if (req.originalUrl.includes('/api/v1/webhook/') && err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        try {
            let status = 400, isValid = false
            let urlSplitData = req.originalUrl.split("/")
            let reqBody = { originalUrl: req.originalUrl, body: { data: err.body }, params: { mo_no: urlSplitData[urlSplitData.length - 2], unique_id: urlSplitData[urlSplitData.length - 1] } }
            let roomId = isSocketConnected(reqBody)
            let successJson = { status, socket_status: (!!roomId ? 200 : 400) }
            sendDataToSocekt(reqBody, isValid, successJson, status)
            res.status(status).json(successJson);
        } catch (error) {

        }
        return
    }
    next();
});

app.post('/api/v1/webhook/:mo_no/:unique_id', checkHeader, (req, res) => {
    try {
        var validate = validator(validateJson)
        let isValid = validate(req.body, { greedy: true });
        let status = isValid ? 200 : 422
        let roomId = isSocketConnected(req)
        let successJson = { status, socket_status: (!!roomId ? 200 : 400), error: !!validate.errors ? 'Invalid request payload. Learn more at https://links.google.com/err-invalid-request-payload' : undefined }
        sendDataToSocekt(req, isValid, successJson, status)
        res.status(status).json(successJson);
    } catch (error) {
        let errJson = { status: 500, socket_status: 500, error: error.message }
        sendDataToSocekt(req, false, errJson, 500)
        res.status(500).json(errJson);
    }
});

app.get('/api/v1/webhook/test/:test_type', async (req, res) => {
    if (req.params.test_type === '1') {
        res.status(200).json({ status: 200 });
    } else if (req.params.test_type === '2') {
        let results = await executeQuery(`SELECT current_database()`)
        if (!!results && results.rows) {
            res.status(200).json({ status: 200 });
            return
        } else {
            res.status(400).json({ status: 400 });
        }
    } else if (req.params.test_type === '3') {
        let results = await executeQuery(`select * from public.api_key order by 1 desc`)
        if (!!results && results.rows && results.rows.length > 0) {
            res.status(200).json({ status: 200, data: results.rows[0] });
            return
        } else {
            let results = await executeQuery(`insert into public.api_key (ak_key) values ($1) returning *`, [uuid()])
            res.status(200).json({ status: 200, data: results.rows[0] });
        }
    } else {
        res.status(500).json({ status: 500 });
    }
});

app.post('/api/v1/apikey/add', async (req, res) => {
    try {
        let getKeyData = await executeQuery(`select * from public.api_key where ak_key = $1 order by 1 desc`, [req.body.key])
        if (!!getKeyData && getKeyData.rows && getKeyData.rows.length > 0) {
            res.status(200).json({ status: 200, data: getKeyData.rows[0] });
            return
        }

        let results = await executeQuery(`insert into public.api_key (ak_key) values ($1) returning *`, [req.body.key])
        if (!!results) {
            res.status(200).json({ status: 200, data: results.rows[0] });
        } else {
            res.status(400).json({ status: 400 });
        }
    } catch (error) {
        res.status(500).json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.post('/api/v1/apikey/execute', async (req, res) => {
    try {
        let results = await executeQuery(req.body.query)
        res.status(200).json({ status: 200, data: results });
    } catch (error) {
        res.status(500).json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.delete('/api/v1/apikey/:key', async (req, res) => {
    try {
        let results = await executeQuery(`delete from public.api_key where ak_key = $1`, [req.params.key])
        if (!!results) {
            res.status(200).json({ status: 200 });
        } else {
            res.status(400).json({ status: 400 });
        }
    } catch (error) {
        res.status(500).json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.get('/proxy/:proxyUrl*', (req, res) => {
    req.url = req.url.replace('/proxy/', '/');
    cors_proxy.emit('request', req, res);
});

app.get('/robots.txt', (req, res) => {
    res.sendFile(__dirname + '/robots.txt');
});

app.use('/', async (req, res) => {
    let dbResults = await executeQuery(`SELECT current_database()`)
    let apiResults = await executeQuery(`select * from public.api_key`)
    res.render('congratulations', { dbURL: !!dbResults && dbResults.rows && dbResults.rows.length > 0 });
});

async function createTable() {
    executeQuery('CREATE TABLE IF NOT EXISTS public.missed_webhook (mw_id bigserial, mw_data json, mw_socket_id text, mw_config json, mw_created_at timestamp with time zone DEFAULT now()); CREATE TABLE IF NOT EXISTS public.api_key (ak_id bigserial, ak_key text, ak_created_at timestamp with time zone DEFAULT now());');
}

function addDataInWebhookQueue(sendData) {
    executeQuery('insert into public.missed_webhook (mw_data, mw_socket_id) values ($1, $2)', [JSON.stringify(sendData), sendData.socketId]);
}

function getMissedWebhookBySocekt(roomId) {
    return new Promise(async (resolve) => {
        let results = await executeQuery(`select * from public.missed_webhook where mw_socket_id = $1`, [roomId]);
        resolve(results?.rows)
    })
}

function checkIsKeyAdded(key) {
    return new Promise(async (resolve) => {
        let results = await executeQuery(`select * from public.api_key where ak_key = $1`, [key]);
        resolve(results?.rows)
    })
}

function deleteMissedWebhookBySocekt(id) {
    return new Promise(async (resolve) => {
        await executeQuery(`delete from public.missed_webhook where mw_id = $1`, [id]);
        resolve(true)
    })
}

function executeQuery(query, value = []) {
    return new Promise(async (resolve) => {
        try {
            if (!!pool) {
                let results = await pool.query(query, value);
                resolve(results)
            } else {
                resolve(null)
            }
        } catch (error) {
            resolve(null)
        }
    })
}