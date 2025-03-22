import { Injectable } from '@nestjs/common';
import axios from 'axios'; 
import { ConfigService } from '@nestjs/config';
import { AppConfig } from 'src/app.config';

@Injectable()
export class BotService {
  private readonly apiUrl = 'https://myteam.mail.ru/bot/v1';

  constructor(private readonly configService: ConfigService) {}

  async getSelfInfo(): Promise<any> {
    const url = `${this.apiUrl}/self/get`;
    const params = {
      token: this.configService.get<AppConfig['VK_BOT_TOKEN']>('VK_BOT_TOKEN'),
    };

    try {
      const response = await axios.get(url, { params });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch self info: ${error.message}`);
    }
  }
}