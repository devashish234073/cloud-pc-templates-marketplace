package com.example.dao;

import com.example.model.Item;
import java.util.List;

public interface AppDao {
    List<Item> getItems();
    void saveItem(Item item);
}
