//
//  AppDelegate.swift
//  幻世传说
//
//  独立运行的「幻世传说」BBK 模拟器宿主 App:
//  启动即进入 HDBBKEmulatorViewController(等价于原 FMJ App 里点击 M 按钮的效果)。
//  采用 UIScene 生命周期(窗口在 SceneDelegate 中创建), 否则在新 SDK 下会因
//  "NoSceneLifecycleAdoption" 在启动时崩溃。
//
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    // MARK: - UISceneSession Lifecycle
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let cfg = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        cfg.delegateClass = SceneDelegate.self
        return cfg
    }
}
