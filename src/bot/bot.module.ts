import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PrismaService } from 'src/prisma.service';

@Module({
  providers: [BotService, PrismaService],
  controllers: [BotController],
})
export class BotModule {}
