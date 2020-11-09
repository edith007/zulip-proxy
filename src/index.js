const bodyParser = require('body-parser');
const express = require('express');
const FormData = require('form-data');
const http = require('http');
const process = require('process');
const sessionHandler = require('express-session');
const websocket = require('./websocket');

const game = require('./game');
const zulip = require('./zulip');

let config;

try {
    config = require('../oauth_config');
} catch {
    console.info('\n\nERROR IN CONFIG\n');
    console.info('cp oauth_config.example.js oauth_config');
    console.info('vim oauth_config\n');
    process.exit();
}

const host = config.host;
const port = config.port;
const app_url = config.app_url;
const client_id = config.client_id;
const client_secret = config.client_secret;
const redirect_uri = config.redirect_uri;
const session_secret = config.session_secret;

const session_opts = {
    secret: session_secret,
    cookie: {
        maxAge: 60 * 60 * 1000, // 1 hour
        sameSite: 'strict',
    },
    resave: false,
    rolling: true, // updates the cookie so it'll never expire under constant use.
    saveUninitialized: false,
};

function pretty(obj) {
    return JSON.stringify(obj, null, 4);
}

console.info(`config:\n ${pretty(config)}\n`);

const z = zulip.make({
    app_url: app_url,
});

async function start_session(session, token_resp) {
    session.access_token = token_resp.access_token;
    const me = await z.get_current_user(session);
    session.user_id = me.user_id;
    session.save();
}

async function single_page_app(res, session) {
    console.info(`User ${session.user_id} has connected`);

    const page_params = {};

    // Get full user info, in case things
    // like names have changed.
    const me = await z.get_current_user(session);

    page_params.games = game.get_user_data(me.user_id);
    page_params.me = me;
    page_params.app_url = app_url;

    res.render('index.pug', {
        page_params: JSON.stringify(page_params),
    });
}

function build_endpoints(app) {
    app.get('/', (req, res) => {
        const session = req.session;

        if (!session || !session.access_token) {
            return res.redirect('/login');
        }

        single_page_app(res, session);
    });

    app.get('/login', (req, res) => {
        const code_url = `${app_url}/${z.oauth_prefix}/authorize?approval_prompt=auto&response_type=code&client_id=${client_id}&scope=write&redirect_uri=${redirect_uri}`;
        res.send(`<a href=${code_url}>Login with your Zulip credentials</a>`);
    });

    app.get('/logout', (req, res) => {
        const session = req.session;
        if (session) {
            const access_token = session.access_token;
            session.destroy();
            const params = {
                access_token,
                client_id,
                client_secret,
            };
            z.revoke_token(params);
        }
        res.redirect('/login');
    });

    app.get('/o/callback', async (req, res) => {
        if (!req.query.code) {
            return res.send('SOMETHING WENT WRONG');
        }
        try {
            const form = new FormData();
            form.append('client_id', client_id);
            form.append('client_secret', client_secret);
            form.append('redirect_uri', redirect_uri);
            form.append('grant_type', 'authorization_code');
            form.append('code', req.query.code);
            const token_resp = await z.get_access_token(form);

            console.log(token_resp.data);

            await start_session(req.session, token_resp.data);

            // redirect to the home page
            res.redirect('/');
        } catch (e) {
            console.error('ERROR', e);
            return res.send({
                req: e.toJSON(),
                data: e.response.data,
            });
        }
    });

    app.get('/z/*', async (req, res) => {
        const url = req.path.slice(3);
        z.api_get(req, res, url);
    });

    app.post('/z/*', async (req, res) => {
        const url = req.path.slice(3);
        z.api_post(req, res, url);
    });

    app.get('/user_uploads/*', async (req, res) => {
        z.handle_user_uploads(req, res);
    });
}

const app = express();

const session_parser = sessionHandler(session_opts);

app.use(bodyParser.json());
app.set('view engine', 'pug');
app.set('views', './views');
app.use(express.static('public'));
app.use(session_parser);
build_endpoints(app);

const server = http.createServer(app);

websocket.init(server, session_parser, z);

server.listen(port, () => {
    console.log(`TO START: visit ${host}:${port} in your browser`);
});
