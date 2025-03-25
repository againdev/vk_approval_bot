import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/app.config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { PrismaService } from 'src/prisma.service';
import { TASK_STATUS, USER_STEPS } from './bot.types';

@Injectable()
export class BotService {
  private readonly apiUrl = 'https://myteam.mail.ru/bot/v1';
  private lastEventId: number = 0;
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
  ) {
    this.startPolling();
    this.startReminderChecks();
  }

  async onModuleInit() {
    const redis = this.redisService.getOrThrow();
    console.log('Clearing Redis data...');
    await redis.flushdb();
    console.log('Redis cleared.');
  }

  private startPolling() {
    const pollTime = 3;
    const interval = setInterval(async () => {
      try {
        this.logger.log(`Polling events with lastEventId: ${this.lastEventId}`);
        const events = await this.getEvents(this.lastEventId, pollTime);
        if (events.ok && events.events.length > 0) {
          for (const event of events.events) {
            this.logger.log(`New event: ${JSON.stringify(event)}`);
            if (event.type === 'newMessage') {
              const { chat, text } = event.payload;
              const chatId = chat.chatId;
              await this.handleMessage(chatId, text, event);
            } else if (event.type === 'callbackQuery') {
              await this.handleCallback(event);
            }
            this.lastEventId = event.eventId;
          }
        }
      } catch (error) {
        this.logger.error(`Error polling events: ${error.message}`);
      }
    }, pollTime * 1000);

    this.schedulerRegistry.addInterval('pollEvents', interval);
  }

  private startReminderChecks() {
    const reminderCheckInterval = 30 * 1000;
    const interval = setInterval(async () => {
      try {
        this.logger.log('Checking for pending reminders...');
        const now = new Date();

        const tasks = await this.prisma.task.findMany({
          where: {
            status: 'PENDING',
            lastRemind: {
              lt: now,
            },
          },
        });

        for (const task of tasks) {
          try {
            const message = `У вас есть задача на утверждение: ${task.text}`;
            await this.sendReminderWithButtons(task.userToId, task.id);

            const newLastRemind = new Date(
              now.getTime() + task.remindInterval * 60 * 1000,
            );
            await this.prisma.task.update({
              where: { id: task.id },
              data: { lastRemind: newLastRemind },
            });

            this.logger.log(`Reminder sent for task: ${task.id}`);
          } catch (error) {
            this.logger.error(
              `Error sending reminder for task ${task.id}: ${error.message}`,
            );
          }
        }
      } catch (error) {
        this.logger.error(`Error checking reminders: ${error.message}`);
      }
    }, reminderCheckInterval);

    this.schedulerRegistry.addInterval('reminderChecks', interval);
  }

  private async sendReminderWithButtons(
    chatId: string,
    taskId: string,
  ): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) {
      this.logger.error(`Задача с ID ${taskId} не найдена.`);
      throw new Error(`Задача с ID ${taskId} не найдена.`);
    }

    let messageText =
      `📨 *Новая задача на утверждение*\n\n` +
      `*От:* ${task.firstName} ${task.lastName}\n`;
    if (task.text) {
      messageText += `*Описание задачи:* ${task.text || 'Описание отсутствует'}\n`;
    }
    if (task.fileId) {
      messageText += `*Описание файла:* ${task.fileCaption || 'Описание отсутствует'}\n`;
    }

    const inlineKeyboardMarkup = [
      [
        {
          text: 'Подтвердить',
          callbackData: `approve_${taskId}`,
          style: 'primary',
        },
        {
          text: 'Отклонить',
          callbackData: `reject_${taskId}`,
          style: 'attention',
        },
      ],
    ];

    if (task.fileId) {
      const fileUrl = `${this.apiUrl}/messages/sendFile`;
      const fileParams = {
        token:
          this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
        chatId,
        fileId: task.fileId,
        caption: messageText,
        inlineKeyboardMarkup: JSON.stringify(inlineKeyboardMarkup),
        parseMode: 'MarkdownV2',
      };

      try {
        await axios.get(fileUrl, { params: fileParams });
        this.logger.log(
          `Файл с сообщением отправлен в ${chatId}: ${task.fileId}`,
        );
      } catch (error) {
        this.logger.error(
          `Ошибка при отправке файла в ${chatId}: ${error.message}`,
        );
        throw error;
      }
    } else {
      const textUrl = `${this.apiUrl}/messages/sendText`;
      const textParams = {
        token:
          this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
        chatId,
        text: messageText,
        parseMode: 'MarkdownV2',
        inlineKeyboardMarkup: JSON.stringify(inlineKeyboardMarkup),
      };

      try {
        await axios.post(textUrl, null, { params: textParams });
        this.logger.log(
          `Сообщение с кнопками отправлено в ${chatId}: ${messageText}`,
        );
      } catch (error) {
        this.logger.error(
          `Ошибка при отправке сообщения в ${chatId}: ${error.message}`,
        );
        throw error;
      }
    }
  }

  async getSelfInfo(): Promise<any> {
    const url = `${this.apiUrl}/self/get`;
    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
    };

    try {
      const response = await axios.get(url, { params });
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get self info: ${error.message}`);
      throw error;
    }
  }

  async getEvents(lastEventId: number, pollTime: number): Promise<any> {
    const url = `${this.apiUrl}/events/get`;
    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
      lastEventId,
      pollTime,
    };

    try {
      const response = await axios.get(url, { params });
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to get events: ${error.message}`);
      throw error;
    }
  }

  async handleMessage(chatId: string, text: string, event: any): Promise<any> {
    const url = `${this.apiUrl}/messages/sendText`;
    let responseText: string;
    let inlineKeyboardMarkup: any[] = [];

    const redis = this.redisService.getOrThrow();
    const userState = await redis.get(chatId);

    const file = event.payload.parts?.find(
      (part: any) => part.type === 'file',
    )?.payload;

    if (userState) {
      const { step, taskData } = JSON.parse(userState);

      let urlParts;
      let contactId;

      switch (step) {
        case USER_STEPS.AWAITING_DESCRIPTION:
          taskData.description = text;
          taskData.firstName = event.payload.from.firstName;
          taskData.lastName = event.payload.from.lastName;
          if (file) {
            taskData.fileId = file.fileId;
            taskData.fileCaption = file.caption;
          }
          await redis.set(
            chatId,
            JSON.stringify({ step: USER_STEPS.AWAITING_USER_ID, taskData }),
            'EX',
            3600,
          );
          responseText =
            'Отправьте контакт из ваших контактов, кому нужно назначить задачу:';
          break;

        case USER_STEPS.AWAITING_USER_ID:
          urlParts = text.split('/');
          contactId = urlParts[urlParts.length - 1];

          if (!contactId || !contactId.includes('@')) {
            responseText =
              'Некорректная ссылка. Отправьте контакт из ваших контактов.';
            break;
          }

          try {
            const user = await this.prisma.user.findUnique({
              where: { vkId: contactId },
            });

            if (!user) {
              responseText = 'Пользователь с таким userId не найден.';
              break;
            }

            taskData.userId = contactId;
            if (file) {
              taskData.fileId = file.fileId;
              taskData.fileCaption = file.caption;
            }

            await redis.set(
              chatId,
              JSON.stringify({ step: USER_STEPS.AWAITING_TIME, taskData }),
              'EX',
              3600,
            );
            responseText = 'Введите интервал напоминания в минутах:';
          } catch (error) {
            this.logger.error(
              `Ошибка при проверке пользователя: ${error.message}`,
            );
            responseText =
              'Произошла ошибка при проверке вашего аккаунта. Попробуйте снова.';
          }
          break;

        case USER_STEPS.AWAITING_USER_ID_FOR_TASKS:
          urlParts = text.split('/');
          contactId = urlParts[urlParts.length - 1];

          if (!contactId || !contactId.includes('@')) {
            responseText =
              'Некорректная ссылка. Отправьте контакт из ваших контактов.';
            break;
          }

          try {
            const userToCheck = await this.prisma.user.findUnique({
              where: { vkId: contactId },
            });

            if (!userToCheck) {
              responseText = 'Пользователь с таким userId не найден.';
              break;
            }

            const tasks = await this.prisma.task.findMany({
              where: {
                userToId: contactId,
              },
              orderBy: {
                createdAt: 'desc',
              },
              take: 10,
            });

            if (tasks.length === 0) {
              responseText = `У пользователя ${userToCheck.firstName} ${userToCheck.lastName} нет задач.`;
            } else {
              responseText = `📝 *Последние 10 задач пользователя ${userToCheck.firstName} ${userToCheck.lastName}:*\n\n`;

              for (const task of tasks) {
                const assignedUser = await this.prisma.user.findUnique({
                  where: { vkId: task.userToId },
                });

                responseText +=
                  `*Задача ${tasks.indexOf(task) + 1}:*\n` +
                  `*Описание:* ${task.text ? task.text : task.fileCaption || 'Описание отсутствует'}\n` +
                  `*Для кого:* ${assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}` : 'Неизвестный пользователь'}\n` +
                  `*Статус:* ${task.status === 'APPROVED' ? 'Подтверждена' : task.status === 'REJECTED' ? 'Отклонена' : 'В ожидании'}\n` +
                  `*Создано:* ${task.createdAt.toLocaleString()}\n\n`;
              }
            }

            await redis.del(chatId);
          } catch (error) {
            this.logger.error(`Ошибка при получении задач: ${error.message}`);
            responseText =
              'Произошла ошибка при получении задач. Попробуйте снова.';
          }
          break;

        case USER_STEPS.AWAITING_TIME:
          const interval = parseInt(text, 10);
          if (isNaN(interval) || interval <= 0) {
            responseText =
              'Неверный формат интервала. Введите положительное число.';
            break;
          }

          taskData.remindInterval = interval;

          try {
            await this.prisma.task.create({
              data: {
                userToId: taskData.userId,
                chatId: chatId,
                firstName: taskData.firstName,
                lastName: taskData.lastName,
                text: taskData.description,
                fileId: taskData.fileId,
                fileCaption: taskData.fileCaption,
                status: TASK_STATUS.PENDING,
                remindInterval: taskData.remindInterval,
                lastRemind: new Date(),
              },
            });
            this.logger.log(`Задача создана: ${JSON.stringify(taskData)}`);
            responseText = 'Задача успешно создана!';
          } catch (error) {
            this.logger.error(`Ошибка при создании задачи: ${error.message}`);
            responseText =
              'Произошла ошибка при создании задачи. Попробуйте снова.';
            break;
          }

          await redis.del(chatId);
          break;

        default:
          responseText =
            'Неизвестная команда. Используйте /help для списка команд.';
          break;
      }
    } else {
      const command = text.split(' ')[0];

      switch (command) {
        case '/start':
          await redis.del(chatId);

          const { firstName, lastName } = event.payload.from;

          try {
            await this.prisma.user.upsert({
              where: { vkId: chatId },
              update: {},
              create: {
                vkId: chatId,
                firstName,
                lastName,
              },
            });
            this.logger.log(
              `Пользователь ${chatId} добавлен или уже существует.`,
            );
          } catch (error) {
            this.logger.error(
              `Ошибка при добавлении пользователя: ${error.message}`,
            );
            throw error;
          }

          responseText = `Добро пожаловать! Выберите команду:`;
          inlineKeyboardMarkup = [
            [
              {
                text: 'Создать задачу',
                callbackData: 'create_task',
                style: 'primary',
              },
              {
                text: 'Посмотреть задачи пользователя',
                callbackData: 'check_user_tasks',
                style: 'primary',
              },
            ],
            [
              {
                text: 'Просмотреть последние задачи',
                callbackData: 'watch_tasks',
                style: 'primary',
              },
            ],
            [
              {
                text: 'Просмотреть статистику',
                callbackData: 'watch_statistics',
                style: 'primary',
              },
            ],
          ];
          break;

        case '/help':
          responseText = `Доступные команды:
    /start - Начать работу с ботом
    /create-task - Создать новую задачу
    /delete-task - Удалить задачу
    /watch-last-tasks - Просмотреть последние задачи
    /help - Получить список команд`;
          break;

        default:
          responseText =
            'Неизвестная команда. Используйте /help для списка команд.';
          break;
      }
    }

    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
      chatId,
      text: responseText,
      parseMode: 'MarkdownV2',
      inlineKeyboardMarkup:
        inlineKeyboardMarkup.length > 0
          ? JSON.stringify(inlineKeyboardMarkup)
          : null,
    };

    try {
      this.logger.log(
        `Отправка сообщения: ${JSON.stringify({ chatId, text: responseText, inlineKeyboardMarkup })}`,
      );
      const response = await axios.post(url, null, { params });
      this.logger.log(`Ответ от API: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (error) {
      this.logger.error(`Ошибка при отправке сообщения: ${error.message}`);
      throw error;
    }
  }

  async handleCallback(event: any): Promise<any> {
    console.log('Получен callback:', event);

    const { callbackData, queryId } = event.payload;
    const chatId = event.payload.message.chat.chatId;
    const userId = event.payload.from.userId;

    let responseText: string;

    const redis = this.redisService.getOrThrow();
    const userState = await redis.get(chatId);
    const { step, taskData } = userState
      ? JSON.parse(userState)
      : { step: null, taskData: {} };

    if (
      callbackData.startsWith('approve_') ||
      callbackData.startsWith('reject_')
    ) {
      const [action, taskId] = callbackData.split('_');

      try {
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { status: true },
        });

        if (!task) {
          responseText = 'Задача не найдена.';
        } else if (task.status === 'PENDING') {
          const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
          await this.prisma.task.update({
            where: { id: taskId },
            data: { status: newStatus },
          });

          responseText =
            action === 'approve'
              ? 'Задача успешно подтверждена!'
              : 'Задача отклонена.';
        } else if (task.status === 'APPROVED') {
          responseText = 'Задача уже подтверждена.';
        } else if (task.status === 'REJECTED') {
          responseText = 'Задача уже отклонена.';
        } else {
          responseText = 'Неизвестный статус задачи.';
        }
      } catch (error) {
        this.logger.error(`Ошибка при обновлении задачи: ${error.message}`);
        responseText =
          'Произошла ошибка при обработке задачи. Попробуйте снова.';
      }
    } else {
      switch (callbackData) {
        case 'create_task':
          await redis.set(
            chatId,
            JSON.stringify({
              step: USER_STEPS.AWAITING_DESCRIPTION,
              taskData: {},
            }),
          );
          responseText = 'Введите описание задачи:';
          break;

        case 'watch_tasks':
          try {
            const tasks = await this.prisma.task.findMany({
              where: {
                chatId: userId,
              },
              orderBy: {
                createdAt: 'desc',
              },
              take: 10,
            });

            if (tasks.length === 0) {
              responseText = 'У вас нет созданных задач.';
            } else {
              responseText = '📝 *Последние 10 задач:*\n\n';

              for (const task of tasks) {
                const assignedUser = await this.prisma.user.findUnique({
                  where: { vkId: task.userToId },
                });

                responseText +=
                  `*Задача ${tasks.indexOf(task) + 1}:*\n` +
                  `*Описание:* ${task.text ? task.text : task.fileCaption || 'Описание отсутствует'}\n` +
                  `*Для кого:* ${assignedUser ? `${assignedUser.firstName} ${assignedUser.lastName}` : 'Неизвестный пользователь'}\n` +
                  `*Статус:* ${task.status === 'APPROVED' ? 'Подтверждена' : task.status === 'REJECTED' ? 'Отклонена' : 'В ожидании'}\n` +
                  `*Создано:* ${task.createdAt.toLocaleString()}\n\n`;
              }
            }
          } catch (error) {
            this.logger.error(`Ошибка при получении задач: ${error.message}`);
            responseText =
              'Произошла ошибка при получении задач. Попробуйте снова.';
          }
          break;

        case 'check_user_tasks':
          await redis.set(
            chatId,
            JSON.stringify({
              step: USER_STEPS.AWAITING_USER_ID_FOR_TASKS,
              taskData: {},
            }),
          );
          responseText = 'Отправьте контакт пользователя:';
          break;

        case 'watch_statistics':
          try {
            const totalTasks = await this.prisma.task.count({
              where: {
                chatId: userId,
              },
            });

            const approvedTasks = await this.prisma.task.count({
              where: {
                chatId: userId,
                status: 'APPROVED',
              },
            });

            const rejectedTasks = await this.prisma.task.count({
              where: {
                chatId: userId,
                status: 'REJECTED',
              },
            });

            const pendingTasks = await this.prisma.task.count({
              where: {
                chatId: userId,
                status: 'PENDING',
              },
            });

            responseText =
              `📊 *Статистика по вашим задачам:*\n\n` +
              `• Всего создано задач: ${totalTasks}\n` +
              `• Одобрено: ${approvedTasks}\n` +
              `• Отклонено: ${rejectedTasks}\n` +
              `• В ожидании: ${pendingTasks}`;
          } catch (error) {
            this.logger.error(
              `Ошибка при получении статистики: ${error.message}`,
            );
            responseText =
              'Произошла ошибка при получении статистики. Попробуйте снова.';
          }
          break;

        default:
          responseText =
            'Неизвестная команда. Используйте /help для списка команд.';
          break;
      }
    }

    try {
      await this.answerCallbackQuery(queryId, 'Команда обработана');
    } catch (error) {
      this.logger.error(`Failed to answer callback query: ${error.message}`);
      throw error;
    }

    const url = `${this.apiUrl}/messages/sendText`;
    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
      chatId,
      text: responseText,
      parseMode: 'MarkdownV2',
    };

    try {
      console.log('Отправка сообщения:', { chatId, text: responseText });
      const response = await axios.post(url, null, { params });
      console.log('Ответ от API:', response.data);
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to send message: ${error.message}`);
      throw error;
    }
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<any> {
    const url = `${this.apiUrl}/messages/answerCallbackQuery`;
    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
      queryId,
      text,
    };

    try {
      const response = await axios.get(url, { params });
      return response.data;
    } catch (error) {
      this.logger.error(`Failed to answer callback query: ${error.message}`);
      throw error;
    }
  }
}
