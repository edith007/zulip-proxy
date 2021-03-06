const bodyParser = require('body-parser');
const express = require('express');
const FormData = require('form-data');
const http = require('http');
const process = require('process');
const sessionHandler = require('express-session');
const websocket = require('./websocket');

const webpack = require('webpack');
const webpack_middleware = require('webpack-dev-middleware');
const webpack_config = require('../webpack.config.js');

const zulip_client = require('./zulip_client');

let config;

try {
    config = require('../config');
} catch {
    console.info('\n\nERROR IN CONFIG\n');
    console.info('cp config.example.js config');
    console.info('vim config\n');
    process.exit();
}

const host = config.host;
const port = config.port;
const app_url = config.app_url;
const client_id = config.client_id;
const client_secret = config.client_secret;
const redirect_uri = config.redirect_uri;
const session_secret = config.session_secret;
const use_api_key = config.use_api_key;

if (!use_api_key && !client_id) {
    throw Error('We need an oauth client id');
}

if (use_api_key && client_id) {
    throw Error(
        'You provided a client_id, but we are using api keys for login.'
    );
}

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

const zulip = zulip_client.make({
    app_url: app_url,
});

async function set_session_user_id(session) {
    const me = await zulip.get_current_user(session);
    session.user_id = me.user_id;
    session.save();
}

async function single_page_app(res, session) {
    console.info(`User ${session.user_id} has connected`);

    const page_params = {};

    // Get full user info, in case things
    // like names have changed.
    const me = await zulip.get_current_user(session);

    page_params.me = me;
    page_params.app_url = app_url;

    res.render('index.pug', {
        page_params: JSON.stringify(page_params),
    });
}

function redirect_to_login(res, reason) {
    console.info('sending user to login page for reason:', reason);
    const encoded_reason = encodeURIComponent(reason);
    res.redirect(`login?reason=${encoded_reason}`);
}

function build_endpoints(app) {
    app.get('/', (req, res) => {
        const session = req.session;

        if (session && (session.access_token || session.api_key)) {
            return single_page_app(res, session);
        }

        redirect_to_login(res, 'You must log in to start a session.');
    });

    app.get('/login', (req, res) => {
        if (use_api_key) {
            // TODO: move this to a pug file
            const html = `
                <div>
                    ${req.query.reason}
                </div>

                <form action="/confirm_api_login">

                <div>
                    <label for="email">email:</label>
                    <input type="text" name="email">
                </div>

                <div>
                    <label for="api_key">api_key:</label>
                    <input type="password" name="api_key">
                </div>

                <input type="submit" value="Sign in">

                </form>
            `;
            res.send(html);
            return;
        }

        const code_url = `${app_url}/${zulip.oauth_prefix}/authorize?approval_prompt=auto&response_type=code&client_id=${client_id}&scope=write&redirect_uri=${redirect_uri}`;
        res.send(`<a href=${code_url}>Login with your Zulip credentials</a>`);
    });

    app.get('/confirm_api_login', async (req, res) => {
        const email = req.query.email;
        const api_key = req.query.api_key;

        if (!email || !api_key) {
            return res.send('You did not provide enough info');
        }

        const session = req.session;
        session.email = email;
        session.api_key = api_key;
        try {
            await set_session_user_id(session);
        } catch (e) {
            if (e.response) {
                console.log(e.response.status, e.response.statusText, email);
            } else {
                console.log('failed to get user info', e);
            }
            session.destroy();
            redirect_to_login(
                res,
                'Your login was not authorized for some reason.'
            );
            return;
        }
        res.redirect('/');
    });

    app.get('/logout', (req, res) => {
        const session = req.session;
        if (session) {
            session.destroy();

            if (!use_api_key) {
                const access_token = session.access_token;

                const params = {
                    access_token,
                    client_id,
                    client_secret,
                };
                zulip.revoke_token(params);
            }
        }
        redirect_to_login(res, 'You have successfully logged out.');
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
            const token_resp = await zulip.get_access_token(form);

            console.log(token_resp.data);

            const session = req.session;
            session.access_token = token_resp.data.access_token;
            await set_session_user_id(session);

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
        zulip.api_get(req, res, url);
    });

    app.post('/z/*', async (req, res) => {
        const url = req.path.slice(3);
        zulip.api_post(req, res, url);
    });

    app.get('/user_uploads/*', async (req, res) => {
        zulip.handle_user_uploads(req, res);
    });
}

const app = express();

const session_parser = sessionHandler(session_opts);

app.use(bodyParser.json());
app.set('view engine', 'pug');
app.set('views', './views');
app.use(express.static('client'));
app.use(session_parser);
app.use(
    webpack_middleware(webpack(webpack_config), {
        publicPath: webpack_config.output.publicPath,
    })
);
build_endpoints(app);

const server = http.createServer(app);

websocket.init(server, session_parser, zulip);

server.listen(port, () => {
    console.log(`TO START: visit ${host}:${port} in your browser`);
});
