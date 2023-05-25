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
const { v4: uuidv4 } = require('uuid');
const CyclicDB = require('@cyclic.sh/dynamodb');

server.listen(process.env.PORT || 3098);
app.use(cors({ exposedHeaders: ["Link"] }));
app.use(bodyParser.urlencoded({ extended: true, }));
app.use(bodyParser.json({ limit: "50MB" }));
const agent = new https.Agent({ rejectUnauthorized: false });

// view engine setup
app.set('views', __dirname);
app.set('view engine', 'ejs');

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

    socket.on('webhook_status_update', async function (data) {
        let specificAllData = await getMissedWebhookBySocekt(data.socketId);
        let specificData = (specificAllData || []).map(ele => { return { ...ele.mw_data, createdDate: ele.created } })
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
            res = (res || []).map(ele => { return { ...ele.mw_data, createdDate: ele.created } })
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
        io.to(roomId).emit("pr_webhook_received", sendData)
    } else {
        addDataInWebhookQueue(sendData)
    }
}

async function checkHeader(req, res, next) {
    if (!getDBRef()) {
        res.status(401).json({ status: 401, error: 'Please configure database. Learn more at https://links.google.com/err-config-database' });
        return
    }

    let apiKey = req.headers && (req.headers['API-KEY'] || req.headers['api-key'])
    if (!apiKey) {
        res.status(401).json({ status: 401, error: 'API-KEY header is missing. Learn more at https://links.google.com/err-header-is-missing' });
        return
    }

    let apiKeyData = await getAllItem('api_key', { ak_key: apiKey });
    if (apiKeyData && apiKeyData.length > 0) {
        next()
    } else {
        res.status(401).json({ status: 401, error: 'Unauthorized access. Learn more at https://links.google.com/err-unauthorized-access' });
    }
}

async function checkHeaderChatwoot(req, res, next) {
    if (!getDBRef()) {
        res.status(401).json({ status: 401, error: 'Please configure database. Learn more at https://links.google.com/err-config-database' });
        return
    }
    next()
}

app.get('/api/v1/env/var', async (req, res) => {
    try {
        res.status(200).json({ data: (process?.env || {})[req.body.key] });
    } catch (error) {
        res.status(404).json({ message: error.message });
    }
});

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
        if (getDBRef()) {
            res.status(200).json({ status: 200 });
        } else {
            res.status(400).json({ status: 400 });
        }
    } else if (req.params.test_type === '3') {
        if (getDBRef()) {
            let results = await getAllItem('api_key');
            if (!!results && results.length > 0) {
                res.status(200).json({ status: 200 });
                return
            } else {
                res.status(400).json({ status: 400 });
            }
        } else {
            res.status(400).json({ status: 400 });
        }
    } else {
        res.status(500).json({ status: 500 });
    }
});

app.post('/api/v1/apikey/add', async (req, res) => {
    try {
        let apiKeyData = await getAllItem('api_key', { ak_key: req.body.key });
        if (apiKeyData && apiKeyData.length) {
            res.status(200).json({ status: 200 });
            return
        }

        let bodyData = { ak_id: uuidv4(), ak_key: req.body.key }
        await addItemById('api_key', bodyData.ak_id, bodyData);

        res.status(200).json({ status: 200 });
    } catch (error) {
        res.status(400).json({ status: 400 });
    }
});

app.delete('/api/v1/apikey/:key', async (req, res) => {
    try {
        await deleteItemById('api_key', req.params.key)
        res.status(200).json({ status: 200 });
    } catch (error) {
        res.status(500).json({ status: 500, error: 'Something went wrong. try again after some time.' });
    }
});

app.post('/api/v1/execute', async (req, res) => {
    try {
        let data = await getAllItem(req.body.collection);
        res.status(200).json({ status: 200, data });
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
    let collection = getDBRef(), apiResults = await getAllItem('api_key');
    res.render('congratulations', { dbURL: !!collection, apiKey: !!apiResults && apiResults.length > 0 });
});

async function addDataInWebhookQueue(sendData) {
    let body = {
        mw_id: uuidv4(),
        mw_data: sendData,
        mw_socket_id: sendData.socketId
    }
    await addItemById('missed_webhook', body.mw_id, body);
}

function getMissedWebhookBySocekt(roomId) {
    return new Promise(async (resolve) => {
        let webhookData = await getAllItem('missed_webhook', { mw_socket_id: roomId });
        resolve(webhookData)
    })
}

function deleteMissedWebhookBySocekt(id) {
    return new Promise(async (resolve) => {
        await deleteItemById('missed_webhook', id)
        resolve(true)
    })
}

function getDBRef() {
    return CyclicDB('adorable-rose-pea-coatCyclicDB')
}

async function addItemById(collection, key, data) {
    return await getDBRef().collection(collection).set(key, data)
}

async function getAllItem(collection, filter) {
    let readableItem = []
    let itemList = []

    if (!filter) {
        itemList = await getDBRef().collection(collection).list()
    } else {
        itemList = await getDBRef().collection(collection).filter(filter)
    }

    if (itemList && itemList.results) {
        for (let i = 0; i < itemList.results.length; i++) {
            readableItem.push((await itemList.results[i].get()).props)
        }
    }
    return readableItem
}

async function getItemById(collection, key) {
    let data = await getDBRef().collection(collection).get(key)
    return data?.props || null
}

async function deleteItemById(collection, key) {
    return await getDBRef().collection(collection).delete(key)
}