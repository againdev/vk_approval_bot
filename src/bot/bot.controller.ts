import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BotService } from './bot.service';

@Controller('bot')
export class BotController {
  constructor(private readonly botService: BotService) {}

  @Get('self')
  async getSelfInfo() {
    return this.botService.getSelfInfo();
  }

  @Get('events')
  async getEvents(
    @Query('lastEventId') lastEventId: number,
    @Query('pollTime') pollTime: number,
  ) {
    return this.botService.getEvents(lastEventId, pollTime);
  }
}
