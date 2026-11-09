import { Module } from '@nestjs/common';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'node:path';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => {
        const ssl = config.get<{ rejectUnauthorized: boolean } | undefined>('database.ssl');
        const base: TypeOrmModuleOptions = {
          type: 'postgres',
          host: config.get<string>('database.host'),
          port: config.get<number>('database.port'),
          username: config.get<string>('database.username'),
          password: config.get<string>('database.password'),
          database: config.get<string>('database.database'),
          autoLoadEntities: true,
          // The worker imports fewer feature modules, but relation metadata still
          // needs every entity referenced by Activity (including User/Organization).
          entities: [join(__dirname, '..', '..', '**', '*.entity.{ts,js}')],
          synchronize: false,
          logging: process.env.NODE_ENV === 'development',
        };
        return ssl ? { ...base, ssl } : base;
      },
    }),
  ],
})
export class DatabaseModule {}
