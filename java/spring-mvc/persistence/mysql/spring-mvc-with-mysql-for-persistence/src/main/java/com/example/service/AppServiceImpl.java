package com.example.service;

import com.example.dao.AppDao;
import com.example.model.Item;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class AppServiceImpl implements AppService {

    @Autowired
    private AppDao appDao;

    @Override
    @Transactional
    public List<Item> getItems() {
        return appDao.getItems();
    }

    @Override
    @Transactional
    public void addItem(String name) {
        appDao.saveItem(new Item(name));
    }
}
