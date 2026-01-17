package com.example.controller;

import com.example.model.Item;
import com.example.service.AppService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api")
public class AppController {

    @Autowired
    private AppService appService;

    @GetMapping("/test")
    public String test() {
        return "Application is running";
    }

    @GetMapping("/items")
    public List<Item> getItems() {
        return appService.getItems();
    }

    @PostMapping("/items")
    public String addItem(@RequestParam String name) {
        appService.addItem(name);
        return "Item added";
    }
}
