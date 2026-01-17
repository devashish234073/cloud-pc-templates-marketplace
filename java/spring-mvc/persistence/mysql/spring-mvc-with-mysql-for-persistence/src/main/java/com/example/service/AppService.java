package com.example.service;

import com.example.model.Item;
import java.util.List;

public interface AppService {
    List<Item> getItems();
    void addItem(String name);
}
