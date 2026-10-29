import UIAbility from '@ohos.app.ability.UIAbility';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import Want from '@ohos.app.ability.Want';
import window from '@ohos.window';
import { BusinessError } from '@ohos.base';
import { Global } from '../model/Config';

export default class EntryAbility extends UIAbility {

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    Global.context = this.context;
  }

  onDestroy(): void {
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    // 注入主窗口（横竖屏切换/投屏引导用）
    windowStage.getMainWindow((err: BusinessError, win: window.Window) => {
      if (err.code) {
        console.error(`getMainWindow failed: ${err.code} ${err.message}`);
      } else {
        Global.mainWindow = win;
      }
    });
    windowStage.loadContent('pages/Index', (err: BusinessError) => {
      if (err.code) {
        console.error(`loadContent failed: ${err.code} ${err.message}`);
      }
    });
  }

  onWindowStageDestroy(): void {
  }

  onForeground(): void {
  }

  onBackground(): void {
  }
}
