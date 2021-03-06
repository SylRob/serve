#!/usr/bin/env node

// Native
const http = require('http');
const path = require('path');
const fs = require('fs');
const Readable = require('stream').Readable;
const {promisify} = require('util');
const {parse} = require('url');
const os = require('os');

// Packages
const Ajv = require('ajv');
const checkForUpdate = require('update-check');
const chalk = require('chalk');
const arg = require('arg');
const {write: copy} = require('clipboardy');
const handler = require('serve-handler');
const schema = require('@zeit/schemas/deployment/config-static');
const boxen = require('boxen');
const compression = require('compression');
const iconv = require('iconv-lite');
const qrcode = require('qrcode-terminal');
const chardet = require('chardet');

// Utilities
const SSI = require('./ssi.js');
const pkg = require('../package');

const readFile = promisify(fs.readFile);
const compressionHandler = promisify(compression());

const interfaces = os.networkInterfaces();

const warning = (message) => chalk`{yellow WARNING:} ${message}`;
const info = (message) => chalk`{magenta INFO:} ${message}`;
const error = (message) => chalk`{red ERROR:} ${message}`;

const updateCheck = async (isDebugging) => {
	let update = null;

	try {
		update = await checkForUpdate(pkg);
	} catch (err) {
		const suffix = isDebugging ? ':' : ' (use `--debug` to see full error)';
		console.error(warning(`Checking for updates failed${suffix}`));

		if (isDebugging) {
			console.error(err);
		}
	}

	if (!update) {
		return;
	}

	console.log(`${chalk.bgRed('UPDATE AVAILABLE')} The latest version of \`serve\` is ${update.latest}`);
};

const getHelp = () => chalk`
  {bold.cyan serve} - Static file serving and directory listing

  {bold USAGE}

      {bold $} {cyan serve} --help
      {bold $} {cyan serve} --version
      {bold $} {cyan serve} [-l {underline listen_uri} [-l ...]] [{underline directory}]

      By default, {cyan serve} will listen on {bold 0.0.0.0:5000} and serve the
      current working directory on that address.

      Specifying a single {bold --listen} argument will overwrite the default, not supplement it.

  {bold OPTIONS}

      --help                              Shows this help message

      -v, --version                       Displays the current version of serve

      -l, --listen {underline listen_uri}             Specify a URI endpoint on which to listen (see below) -
                                          more than one may be specified to listen in multiple places

      -d, --debug                         Show debugging information

      -s, --single                        Rewrite all not-found requests to \`index.html\`

      -c, --config                        Specify custom path to \`serve.json\`

      --charset                           override header charset for every http request of html, htm, shtml, css file

      -n, --no-clipboard                  Do not copy the local address to the clipboard

      --ssi                               Set specific URL to get the SSI includes from

      --public                            add specific path for Base URL

      -S, --symlinks                      Resolve symlinks instead of showing 404 errors

  {bold ENDPOINTS}

      Listen endpoints (specified by the {bold --listen} or {bold -l} options above) instruct {cyan serve}
      to listen on one or more interfaces/ports, UNIX domain sockets, or Windows named pipes.

      For TCP ports on hostname "localhost":

          {bold $} {cyan serve} -l {underline 1234}

      For TCP (traditional host/port) endpoints:

          {bold $} {cyan serve} -l tcp://{underline hostname}:{underline 1234}

      For UNIX domain socket endpoints:

          {bold $} {cyan serve} -l unix:{underline /path/to/socket.sock}

      For Windows named pipe endpoints:

          {bold $} {cyan serve} -l pipe:\\\\.\\pipe\\{underline PipeName}
`;

const parseEndpoint = (str) => {
	if (!isNaN(str)) {
		return [str];
	}

	// We cannot use `new URL` here, otherwise it will not
	// parse the host properly and it would drop support for IPv6.
	const url = parse(str);

	switch (url.protocol) {
	case 'pipe:': {
		// some special handling
		const cutStr = str.replace(/^pipe:/, '');

		if (cutStr.slice(0, 4) !== '\\\\.\\') {
			throw new Error(`Invalid Windows named pipe endpoint: ${str}`);
		}

		return [cutStr];
	}
	case 'unix:':
		if (!url.pathname) {
			throw new Error(`Invalid UNIX domain socket endpoint: ${str}`);
		}

		return [url.pathname];
	case 'tcp:':
		url.port = url.port || '5000';
		return [parseInt(url.port, 10), url.hostname];
	default:
		throw new Error(`Unknown --listen endpoint scheme (protocol): ${url.protocol}`);
	}
};

const registerShutdown = (fn) => {
	let run = false;

	const wrapper = () => {
		if (!run) {
			run = true;
			fn();
		}
	};

	process.on('SIGINT', wrapper);
	process.on('SIGTERM', wrapper);
	process.on('exit', wrapper);
};

const getNetworkAddress = () => {
	for (const name of Object.keys(interfaces)) {
		for (const interface of interfaces[name]) {
			const {address, family, internal} = interface;
			if (family === 'IPv4' && !internal) {
				return address;
			}
		}
	}
};


const extractCharset = (filePath, forcedCharset) => {
	if (forcedCharset) {
		return forcedCharset;
	}

	return chardet.detectFileSync(filePath);
};

const realPath = (relativePath) => {
	const possiblePaths = [
		path.join(relativePath, 'index.html'),
		relativePath.endsWith('/') ? relativePath.replace(/\/$/g, '.html') : `${relativePath}.html`
	].filter((item) => path.basename(item) !== '.html');

	for (let index = 0; index < possiblePaths.length; index++) {
		const related = possiblePaths[index];
		const absolutePath = path.join(process.cwd(), related);
		let exist = false;
		try {
			exist = fs.existsSync(absolutePath);
		} catch (err) {
			continue;
		}

		if (exist) {
			return absolutePath;
		}
	}

	return null;
};

const startEndpoint = (endpoint, config, args, previous) => {
	const {isTTY} = process.stdout;
	const clipboard = args['--no-clipboard'] !== true;
	const compress = args['--no-compression'] !== true;
	const allowExt = [
		'css',
		'html',
		'htm',
		'shtml'
	];

	const server = http.createServer(async (request, response) => {
		if (compress) {
			await compressionHandler(request, response);
		}

		let fullPath = path.resolve() + request.url;
		let relativePath = request.url;
		if (path.extname(fullPath) === '') {
			fullPath = realPath(request.url) ? realPath(request.url) : fullPath;
			relativePath = path.relative(process.cwd(), fullPath);
		}

		// prevent url bugs when the URL contain parameter ex: /index.html?foo=bar
		config.cleanUrls = false;

		// set this to true to get slash at the end of an URL that corespond to a folder name
		config.trailingSlash = true;

		const extention = fullPath.split(/\#|\?/)[0].split('.').pop();

		let charset = 'utf-8';
		if (allowExt.indexOf(extention) >= 0) {
			try {
				const tempChar = extractCharset(fullPath, config.charset);
				charset = config.charset ? config.charset : (tempChar ? tempChar : 'utf-8');
				if (!config.headers) {
					config.headers = [];
				}

				config.headers.push({
					source: relativePath,
					headers: [{
						key: 'Content-Type',
						value: `text/${extention}; charset=${config.charset ? config.charset : charset}`
					}]
				});
			} catch (err) {
				// console.log(err);
			}
		} // if (allowExt.indexOf(extention) >= 0)

		return handler(request, response, config, {
			createReadStream(pathToFile) {
				const stream = fs.createReadStream(pathToFile);
				const fileExt = path.extname(pathToFile).substring(1);

				let stats = null;
				try {
					stats = fs.lstatSync(pathToFile);
				} catch (e) {
					return stream;
				}


				return new Promise((resolve) => {
					if (stats.isDirectory()) {
						resolve(stream);
					}

					// SSI part
					if (allowExt.indexOf(fileExt) >= 0 && fileExt !== 'css' && config.ssi) {
						stream
							.pipe(iconv.decodeStream(charset))
							.collect(async (err, body) => {
								const ssi = new SSI({ location: config.ssi, localPath: `${path.resolve()}/${config.public || ''}`, defaultCharset: charset });
								const newHtml = await ssi(body.toString());
								const newStream = new Readable();
								newStream._read = () => {};
								// newStream.push(newHtml);
								newStream.push(iconv.encode(newHtml, charset));
								newStream.push(null);

								resolve(newStream);
							});
					} else {
						resolve(stream);
					} // if (allowExt.indexOf(fileExt) >= 0)
				});
			}
		});
	});

	server.on('error', (err) => {
		if (err.code === 'EADDRINUSE' && endpoint.length === 1 && !isNaN(endpoint[0])) {
			startEndpoint([0], config, args, endpoint[0]);
			return;
		}

		console.error(error(`Failed to serve: ${err.stack}`));
		process.exit(1);
	});

	server.listen(...endpoint, async () => {
		const details = server.address();
		registerShutdown(() => server.close());

		let localAddress = null;
		let networkAddress = null;

		if (typeof details === 'string') {
			localAddress = details;
		} else if (typeof details === 'object' && details.port) {
			const address = details.address === '::' ? 'localhost' : details.address;
			const ip = getNetworkAddress();

			localAddress = `http://${address}:${details.port}`;
			networkAddress = `http://${ip}:${details.port}`;
		}

		if (isTTY && process.env.NODE_ENV !== 'production') {
			let message = chalk.green('Serving!');

			if (localAddress) {
				const prefix = networkAddress ? '- ' : '';
				const space = networkAddress ? '            ' : '  ';

				message += `\n\n${chalk.bold(`${prefix}Local:`)}${space}${localAddress}`;
			}

			if (networkAddress) {
				message += `\n${chalk.bold('- On Your Network:')}  ${networkAddress}`;
				qrcode.generate(networkAddress, {small: true}, function getQrcode(qrcodeString) {
					message += `\n${chalk.bold('- Network adress QR code:')} \n${qrcodeString}`;
				});
			}

			if (previous) {
				message += chalk.red(`\n\nThis port was picked because ${chalk.underline(previous)} is in use.`);
			}

			if (clipboard) {
				try {
					await copy(localAddress);
					message += `\n\n${chalk.grey('Copied local address to clipboard!')}`;
				} catch (err) {
					console.error(error(`Cannot copy to clipboard: ${err.message}`));
				}
			}

			console.log(boxen(message, {
				padding: 1,
				borderColor: 'green',
				margin: 1
			}));
		} else {
			const suffix = localAddress ? ` at ${localAddress}` : '';
			console.log(info(`Accepting connections${suffix}`));
		}
	});
};

const loadConfig = async (cwd, entry, args) => {
	const files = [
		'serve.json',
		'now.json',
		'package.json'
	];

	const exceptionConfig = [
		'ssi',
		'charset',
		'listen'
	];

	if (args['--config']) {
		files.unshift(args['--config']);
	}

	const config = {};

	for (const file of files) {
		const location = path.join(entry, file);
		let content = null;

		try {
			content = await readFile(location, 'utf8');
		} catch (err) {
			if (err.code === 'ENOENT') {
				continue;
			}

			console.error(error(`Not able to read ${location}: ${err.message}`));
			process.exit(1);
		}

		try {
			content = JSON.parse(content);
		} catch (err) {
			console.error(error(`Could not parse ${location} as JSON: ${err.message}`));
			process.exit(1);
		}

		if (typeof content !== 'object') {
			console.error(warning(`Didn't find a valid object in ${location}. Skipping...`));
			continue;
		}

		try {
			switch (file) {
			case 'now.json':
				content = content.static;
				break;
			case 'package.json':
				content = content.now.static;
				break;
			}
		} catch (err) {
			continue;
		}

		Object.assign(config, content);
		console.log(info(`Discovered configuration in \`${file}\``));

		if (file === 'now.json' || file === 'package.json') {
			console.error(warning('The config files `now.json` and `package.json` are deprecated. Please use `serve.json`.'));
		}

		break;
	}

	if (entry) {
		const public = config.public || args['--public'];
		config.public = path.relative(cwd, (public ? path.join(entry, public) : entry));
	}

	const filteredConfig = {};
	Object.keys(config).map((s) => (exceptionConfig.indexOf(s) === -1 ? filteredConfig[s] = config[s] : s));

	if (Object.keys(filteredConfig).length !== 0) {
		const ajv = new Ajv();
		const validateSchema = ajv.compile(schema);

		if (!validateSchema(filteredConfig)) {
			const defaultMessage = error('The configuration you provided is wrong:');
			const {message, params} = validateSchema.errors[0];

			console.error(`${defaultMessage}\n${message}\n${JSON.stringify(params)}`);
			process.exit(1);
		}
	}

	return config;
};

(async () => {
	let args = null;

	try {
		args = arg({
			'--help': Boolean,
			'--version': Boolean,
			'--listen': [parseEndpoint],
			'--single': Boolean,
			'--debug': Boolean,
			'--config': String,
			'--charset': String,
			'--no-clipboard': Boolean,
			'--no-compression': Boolean,
			'--symlinks': Boolean,
			'--ssi': String,
			'--public': String,
			'-h': '--help',
			'-v': '--version',
			'-l': '--listen',
			'-s': '--single',
			'-d': '--debug',
			'-c': '--config',
			'-n': '--no-clipboard',
			'-u': '--no-compression',
			'-S': '--symlinks',
			// This is deprecated and only for backwards-compatibility.
			'-p': '--listen'
		});
	} catch (err) {
		console.error(error(err.message));
		process.exit(1);
	}

	if (process.env.NO_UPDATE_CHECK !== '1') {
		await updateCheck(args['--debug']);
	}

	if (args['--version']) {
		console.log(pkg.version);
		return;
	}

	if (args['--help']) {
		console.log(getHelp());
		return;
	}

	if (!args['--listen']) {
		// Default endpoint
		args['--listen'] = [[process.env.PORT || 5000]];
	}


	if (args._.length > 1) {
		console.error(error('Please provide one path argument at maximum'));
		process.exit(1);
	}

	const cwd = process.cwd();
	const entry = args._.length > 0 ? path.resolve(args._[0]) : cwd;
	const config = await loadConfig(cwd, entry, args);

	if (args['--ssi']) {
		config.ssi = args['--ssi'];
		const urlPattern = /(http|ftp|https):\/\/[\w-]+(\.[\w-]+)*([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/;
		const matches = config.ssi.match(urlPattern);
		if (config.ssi !== '' && !matches) {
			config.ssi = null;
			console.error(error('Please provide url for SSI'));
		}
	}

	if (args['--single']) {
		const {rewrites} = config;
		const existingRewrites = Array.isArray(rewrites) ? rewrites : [];

		// As the first rewrite rule, make `--single` work
		config.rewrites = [{
			source: '**',
			destination: '/index.html'
		}, ...existingRewrites];
	}

	if (args['--symlinks']) {
		config.symlinks = true;
	}

	if (args['--charset']) {
		config.charset = args['--charset'];
	}

	for (const endpoint of args['--listen']) {
		startEndpoint(endpoint, config, args);
	}

	registerShutdown(() => {
		console.log(`\n${info('Gracefully shutting down. Please wait...')}`);

		process.on('SIGINT', () => {
			console.log(`\n${warning('Force-closing all open sockets...')}`);
			process.exit(0);
		});
	});
})();
