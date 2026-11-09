import { Controller, Get, Post, Param, ParseUUIDPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { OrgScoped } from '../../common/decorators/org-scoped.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestContext } from '../../shared/interfaces';
import { ReportsService } from './reports.service';

@Controller('projects/:projectId/reports')
@OrgScoped()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  submit(@Param('projectId', ParseUUIDPipe) projectId: string, @CurrentUser() user: RequestContext) {
    return this.reports.submit(projectId, user.organizationId!, user.userId);
  }

  @Get(':id')
  status(@Param('projectId', ParseUUIDPipe) projectId: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestContext) {
    return this.reports.status(projectId, id, user.organizationId!, user.userId);
  }
}
