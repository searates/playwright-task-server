// @ts-ignore not under root dir
import * as config from "./../config.json";
import {WebServer} from "./WebServer";
import BrowsersPool, {RunOptions} from "./BrowsersPool";
import OS from "os";
import {Stats} from "./Stats";
import Task, {TaskTimes} from "./Task";

const stats = new Stats();

const browsersPool = new BrowsersPool(stats, <RunOptions>config.RUN_OPTIONS, config.ENV_OVERWRITE);
browsersPool.runTaskManager();

const webServer = new WebServer(config.SERVER_PORT, config.ENV_OVERWRITE);

webServer.setAuthKey(config.AUTH_KEY, true);

webServer.get('/', (request, response) => {
    response.json({
        health: 'ok',
    })
})

webServer.get('/stats', (request, response) => {
    response.json({
        tasks: {
            total: stats.getTotalTasks(),
            successful: stats.getTotalTasksSuccessful(),
            failed: stats.getTotalTasksFailed(),
            timeout: stats.getTotalTasksTimeout()
        },
        queue: browsersPool.getQueueLength(),
        workers: browsersPool.getWorkersCount(),
        uptime: OS.uptime(),
        hardware: {
            cpu: {
                avg: {
                    '1': OS.loadavg()[0],
                    '5': OS.loadavg()[1],
                    '15': OS.loadavg()[2]
                }
            }
        },
        ram: {
            total: OS.totalmem(),
            current: OS.totalmem() - OS.freemem(),
        }
    })
});

webServer.post(`/task`, (request, response) => {
    if (typeof request.body.script === 'string') {
        browsersPool.addTask(request.body.script, (scriptStatus: string, scriptReturn = {}, times: TaskTimes) => {
            times.done_at = (new Date).getTime();
            response.json({
                status: scriptStatus,
                metadata: {
                    ...times
                },
                data: {
                    ...scriptReturn
                }
            });
        });
    } else {
        response.json({
            status: 'WRONG_INPUT'
        })
    }

})

webServer.start();
