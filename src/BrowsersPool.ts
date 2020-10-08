import {
    ChromiumBrowser,
    FirefoxBrowser,
    WebKitBrowser,
    BrowserType,
    chromium,
    firefox,
    webkit
} from "playwright";
import stealth from "./modules/stealth";
import Task, {TaskTimes, DONE as TaskDONE, FAIL as TaskFAIL} from "./Task";
import URL from "url";
import OS, {type} from "os";
import {Stats} from "./Stats";
import Context from "./Context";

export interface BrowserTypeLaunchOptionsProxy {
    "server": string,
    "bypass": string,
    "username": string,
    "password": string
}

export interface InlineOptions {
    args: string[],
    headless: boolean,
    slowMo: number,
    proxy: BrowserTypeLaunchOptionsProxy | null | undefined
}

export interface BrowsersList {
    chromium: BrowserType<ChromiumBrowser>,
    firefox: BrowserType<FirefoxBrowser>,
    webkit: BrowserType<WebKitBrowser>,
}

export interface RunOptions {
    MAX_WORKERS: number | null,
    BROWSER: keyof BrowsersList,
    INLINE: InlineOptions
}

export default class BrowsersPool {

    private browser: ChromiumBrowser | FirefoxBrowser | WebKitBrowser | null = null;

    private readonly maxWorkers: number;
    private tasksQueue: Task[] = [];
    private taskManager: NodeJS.Timeout | null = null;

    private defaultBrowserOptions: object = {};

    private contexts: Context[] = [];

    private stats: Stats;
    private readonly runOptions: RunOptions;

    private browserRunnerFlag: boolean = false;

    private modules = {
        URL: URL,
        // pss: promiseSafeSync,
        stealth: stealth,
    };

    public constructor(stats: Stats, runOptions: RunOptions, envOverwrite: boolean = false) {

        //Stats init
        stats.setContexts(this.contexts);
        this.stats = stats;

        //Max Workers
        if (typeof runOptions.MAX_WORKERS === "number" && runOptions.MAX_WORKERS >= 1) {
            this.maxWorkers = runOptions.MAX_WORKERS;
            // @ts-ignore
            if (process.env.PW_TASK_WORKERS !== undefined && envOverwrite && parseInt(process.env.PW_TASK_WORKER) >= 1) {
                // @ts-ignore
                this.maxWorkers = parseInt(process.env.PW_TASK_WORKER);
            }
        }// @ts-ignore
        else if (process.env.PW_TASK_WORKERS !== undefined && parseInt(process.env.PW_TASK_WORKER) >= 1) {
            // @ts-ignore
            this.maxWorkers = parseInt(process.env.PW_TASK_WORKER);
        } else if (OS.cpus().length >= 1) {
            this.maxWorkers = OS.cpus().length * 12;
        } else {
            console.log(`Wrong maxWorkers: ${runOptions.MAX_WORKERS}`);
            console.log(`Dying`);
            process.exit(1);
        }


        //Proxy
        if (runOptions.INLINE.proxy === null && process.env.PW_TASK_PROXY !== undefined) {
            runOptions.INLINE.proxy = {
                server: process.env.PW_TASK_PROXY,
                bypass: process.env.PW_TASK_BYPASS ?? "",
                username: process.env.PW_TASK_USERNAME ?? "",
                password: process.env.PW_TASK_PASSWORD ?? ""
            };
        } else {
            runOptions.INLINE.proxy = undefined;
        }


        //Browser name checker
        if (runOptions.BROWSER === 'chromium' || runOptions.BROWSER === 'firefox' || runOptions.BROWSER === 'webkit') {
            this.runOptions = runOptions;
            this.runBrowser();
        } else {
            console.log(`Wrong browser type: ${runOptions.BROWSER}`);
            console.log(`Dying`);
            process.exit(1);
        }


    }

    public removeContext(context: Context) {
        let statsContextIndex = this.contexts.indexOf(context);
        if (statsContextIndex >= 0) this.contexts.splice(statsContextIndex);
    }


    public async runBrowser() {
        if (!this.browserRunnerFlag) {
            this.browserRunnerFlag = true;

            let browsersList: BrowsersList = {
                chromium: chromium,
                webkit: webkit,
                firefox: firefox,
            }

            try {
                // @ts-ignore
                this.browser = await browsersList[this.runOptions.BROWSER].launch(this.runOptions.INLINE);
            }
                // @ts-ignore
            catch (e: any) {
                console.log(`Error in running browser: ${e}`);
                console.log(`Dying`);
                process.exit(1);
            }
            this.browserRunnerFlag = false;
        }
    }

    public async runTaskManager() {
        console.log('Running Task Manager');


        this.taskManager = setInterval(() => {
            if (this.browser !== null && this.contexts.length < this.maxWorkers) {
                //@ts-ignore
                let task: Task = this.tasksQueue.shift();
                if (task !== undefined) {
                    task.setRunTime((new Date()).getTime());

                    let statsContext = new Context();

                    this.contexts.push(statsContext);

                    (new Promise<any>(async (resolve, reject) => {
                        try {
                            // @ts-ignore
                            const context = await this.browser.newContext();
                            statsContext.setBrowserContext(context);
                            // @ts-ignore
                            await this.modules.stealth(context, this.browser.constructor.name);

                            let script = new Function('context', 'modules',
                                `return new Promise(async (resolve, reject) => {
                                    try {
                                        ${task.getScript()}
                                        resolve({});
                                    }
                                    catch (e) {
                                        reject(e);
                                    }
                                });`
                            );
                            script(context, this.modules)
                                .then(resolve)
                                .catch(reject);
                        } catch (e) {
                            reject(e);
                        }
                    }))
                        .then((response: object) => {
                            this.stats.addSuccess();
                            statsContext.closeContext();
                            this.removeContext(statsContext)

                            if (typeof response !== 'object') {
                                response = {response};
                            }

                            task.getCallback()(TaskDONE, response, task.getTaskTime());
                        })
                        .catch((e: Error) => {
                            statsContext.closeContext();
                            this.removeContext(statsContext)

                            let errorMsg = 'Fail in script calling (runTask)';

                            //if browser not runned
                            if (typeof e.message === 'string' && e.message.indexOf('Target.createBrowserContext') >= 0) {
                                this.runBrowser();
                                this.tasksQueue.push(task);
                            } else {
                                if (typeof e.message === 'string' && e.name === 'TimeoutError') {
                                    errorMsg = 'TimeOut in script';
                                    this.stats.addTimeout();
                                } else {
                                    this.stats.addFail();
                                }

                                task.getCallback()(TaskFAIL, {
                                    'error': errorMsg,
                                    'log': e.toString(),
                                    'stack': e.stack,
                                }, task.getTaskTime());
                            }
                        });
                }
            } else if (this.contexts.length >= this.maxWorkers) {
                console.warn('contextsCounter! Waiting');
            }
        }, 10);
        console.log('Runned Task Manager');
    }

    public stopTaskManager(): void {
        if (this.taskManager !== null) {
            clearInterval(this.taskManager);
            this.taskManager = null;
        }
    }

    public setDefaultBrowserOptions(options: object) {
        this.defaultBrowserOptions = options;
    }

    public getDefaultBrowserOptions() {
        return this.defaultBrowserOptions;
    }

    public addTask(script: string, callback: (scriptStatus: string, scriptReturn: object, times: TaskTimes) => void, options: object | null = null) {
        if (options === null) {
            options = this.getDefaultBrowserOptions();
        }
        this.stats.addTask();
        this.tasksQueue.push(new Task(script, callback, options));
    }

    public getQueueLength(): number {
        return this.tasksQueue.length;
    }

    public getWorkersCount(): number {
        return this.maxWorkers;
    }
}
