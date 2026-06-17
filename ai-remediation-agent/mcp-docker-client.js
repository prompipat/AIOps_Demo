const { execFile } = require('child_process');
const { promisify } = require('util');
const { ALLOWED_SERVICES } = require('./remediation-policy');

const execFileAsync = promisify(execFile);

function assertAllowedService(service) {
    if (!ALLOWED_SERVICES.has(service)) {
        throw new Error(`Service is not allowlisted: ${service}`);
    }
}

async function getContainerForService(service, options = {}) {
    assertAllowedService(service);

    const args = [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.service=${service}`
    ];

    if (options.includeStopped) {
        args.splice(1, 0, '-a');
    }

    const { stdout } = await execFileAsync('docker', args);

    const containerId = stdout.trim().split(/\r?\n/).filter(Boolean)[0];

    if (!containerId) {
        throw new Error(`No ${options.includeStopped ? 'container' : 'running container'} found for service: ${service}`);
    }

    return containerId;
}

async function isContainerRunning(containerId) {
    const { stdout } = await execFileAsync('docker', [
        'inspect',
        '-f',
        '{{.State.Running}}',
        containerId
    ]);

    return stdout.trim() === 'true';
}

async function callDockerTool(toolName, args = {}) {
    switch (toolName) {
        case 'docker_compose.logs':
            return getLogs(args.service, args.tail || 20);

        case 'docker_compose.restart':
            return restartService(args.service);

        case 'docker_compose.ps':
            return composePs();

        default:
            throw new Error(`Unsupported MCP tool: ${toolName}`);
    }
}

async function getLogs(service, tail) {
    const containerId = await getContainerForService(service, { includeStopped: true });

    const { stdout } = await execFileAsync('docker', [
        'logs',
        `--tail=${Number(tail) || 20}`,
        containerId
    ]);

    return stdout;
}

async function restartService(service) {
    const containerId = await getContainerForService(service, { includeStopped: true });
    const isRunning = await isContainerRunning(containerId);

    const command = isRunning ? 'restart' : 'start';
    const { stdout } = await execFileAsync('docker', [
        command,
        containerId
    ]);

    return `Service ${service} ${isRunning ? 'restarted' : 'started'}.\n${stdout}`;
}

async function composePs() {
    const { stdout } = await execFileAsync('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project'
    ]);

    return stdout;
}

module.exports = {
    callDockerTool
}
